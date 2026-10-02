/**
 * Temporal workflow/activity/signal/query/update plugin.
 *
 * Detects Temporal orchestration code across the four official SDKs
 * (Python, TypeScript, Java, Go) and resolves edges from a workflow to the
 * activities it calls (`temporal_executes_activity`), the signals/updates it
 * sends (`temporal_sends_signal` / `temporal_sends_update`), and the child
 * workflows it starts (`temporal_executes_child_workflow`). Queries are
 * tagged via `frameworkRole`/routes only — a query is a synchronous
 * request/response against a running execution with no static "target" to
 * link to.
 *
 * Symbol role is intentionally NOT conveyed via `RawSymbol.metadata` on
 * existing symbols — `SymbolRepository.insertSymbol` does an
 * `ON CONFLICT(symbol_id) DO UPDATE` upsert that would overwrite the real
 * symbol's byte offsets/fqn/signature with this plugin's placeholder values
 * if the auto-filled symbol id collided (see `src/db/repositories/symbol-repository.ts`).
 * Instead, like Kafka/Celery/NestJS, this plugin leaves `FileParseResult.symbols`
 * empty and conveys role via `frameworkRole` (file-level) + `routes` entries;
 * the workflow/activity relationship itself is conveyed purely by the edge.
 */
import path from 'node:path';
import { ok } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  ParsedDependency,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { escapeRegExp } from '../../../../../utils/security.js';
import {
  extractTemporalGo,
  extractTemporalJava,
  extractTemporalPython,
  extractTemporalTypeScript,
  extractPythonConstants,
  findTsActivitiesProxies,
  findTsDefineBindings,
  findTsNamedImports,
  GO_EXECUTE_ACTIVITY_RE,
  GO_EXECUTE_CHILD_WORKFLOW_RE,
  GO_SIGNAL_EXTERNAL_RE,
  JAVA_NEW_ACTIVITY_STUB_RE,
  JAVA_NEW_CHILD_WORKFLOW_STUB_RE,
  JAVA_NEW_EXTERNAL_WORKFLOW_STUB_RE,
  PY_EXECUTE_ACTIVITY_RE,
  PY_EXECUTE_CHILD_WORKFLOW_RE,
  PY_SEND_SIGNAL_RE,
  PY_SEND_UPDATE_RE,
  resolveGoIdentifier,
  TS_EXECUTE_CHILD_RE,
  TS_SEND_SIGNAL_RE,
  TS_SEND_UPDATE_RE,
  TS_SET_HANDLER_RE,
  type JavaInterfaceExtraction,
  type TemporalRole,
  type TemporalSymbolRef,
  type TsDefineBinding,
} from './extract.js';

const TS_EXTENSIONS = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

function routeMethodFor(role: TemporalRole): string {
  switch (role) {
    case 'workflow':
      return 'TEMPORAL_WORKFLOW';
    case 'activity':
      return 'TEMPORAL_ACTIVITY';
    case 'signal':
      return 'TEMPORAL_SIGNAL';
    case 'query':
      return 'TEMPORAL_QUERY';
    case 'update':
      return 'TEMPORAL_UPDATE';
  }
}

/** Maps a resolved role to the edge type a call-site match against it should emit. `query` has no edge. */
function edgeTypeForRole(role: TemporalRole): string | undefined {
  switch (role) {
    case 'activity':
      return 'temporal_executes_activity';
    case 'signal':
      return 'temporal_sends_signal';
    case 'update':
      return 'temporal_sends_update';
    case 'workflow':
      return 'temporal_executes_child_workflow';
    case 'query':
      return undefined;
  }
}

function hasDependency(deps: ParsedDependency[], predicate: (name: string) => boolean): boolean {
  return deps.some((d) => predicate(d.name));
}

interface ResolveSymbol {
  id: number;
  symbolId: string;
  name: string;
  kind: string;
  fqn: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
}

function findEnclosingSymbol(
  symbols: ResolveSymbol[],
  line: number,
  kinds: string[],
): ResolveSymbol | undefined {
  let best: ResolveSymbol | undefined;
  let bestSpan = Infinity;
  for (const s of symbols) {
    if (!kinds.includes(s.kind)) continue;
    if (s.lineStart == null || s.lineEnd == null) continue;
    if (line < s.lineStart || line > s.lineEnd) continue;
    const span = s.lineEnd - s.lineStart;
    if (span < bestSpan) {
      best = s;
      bestSpan = span;
    }
  }
  return best;
}

function lineOfSource(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function makeEdge(sourceId: number, targetId: number, edgeType: string): RawEdge {
  return {
    sourceNodeType: 'symbol',
    sourceRefId: sourceId,
    targetNodeType: 'symbol',
    targetRefId: targetId,
    edgeType,
    resolution: 'text_matched',
  };
}

/** Resolves a relative TS/JS import specifier to a file the project actually indexed. */
function resolveTsModulePath(
  importerPath: string,
  spec: string,
  pathToFile: Map<string, { id: number; path: string }>,
): { id: number; path: string } | undefined {
  if (!spec.startsWith('.')) return undefined;
  const dir = path.posix.dirname(importerPath);
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.mjs`,
    path.posix.join(joined, 'index.ts'),
    path.posix.join(joined, 'index.js'),
  ];
  for (const candidate of candidates) {
    const hit = pathToFile.get(candidate);
    if (hit) return hit;
  }
  return undefined;
}

/** Finds the enclosing function of the `setHandler(constName, ...)` call registering `binding` in `source`. */
function findTsHandlerEnclosing(
  source: string,
  symbols: ResolveSymbol[],
  constName: string,
): ResolveSymbol | undefined {
  const handlerRe = new RegExp(TS_SET_HANDLER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = handlerRe.exec(source)) !== null) {
    if (m[1] !== constName) continue;
    const line = lineOfSource(source, m.index);
    return findEnclosingSymbol(symbols, line, ['function']);
  }
  return undefined;
}

/**
 * Resolves the identifier used at a `.signal(x)` / `.executeUpdate(x)` / `.startUpdate(x)` send
 * site to the workflow function that registered a handler for it, same-file or cross-file via a
 * relative import — mirroring how `findTsActivitiesProxies` resolves activity call sites.
 */
function resolveTsSendTarget(
  ctx: ResolveContext,
  file: { path: string },
  source: string,
  symbols: ResolveSymbol[],
  tsFilesByPath: Map<string, { id: number; path: string }>,
  identifier: string,
): { sym: ResolveSymbol; role: TsDefineBinding['kind'] } | undefined {
  const sameFileBindings = findTsDefineBindings(source);
  const sameFileBinding = sameFileBindings.get(identifier);
  if (sameFileBinding) {
    const enclosing = findTsHandlerEnclosing(source, symbols, identifier);
    if (enclosing) return { sym: enclosing, role: sameFileBinding.kind };
  }

  const imp = findTsNamedImports(source).find((i) => i.localName === identifier);
  if (!imp) return undefined;
  const moduleFile = resolveTsModulePath(file.path, imp.modulePath, tsFilesByPath);
  if (!moduleFile) return undefined;
  const targetSource = ctx.readFile(moduleFile.path);
  if (!targetSource) return undefined;
  const targetBinding = findTsDefineBindings(targetSource).get(imp.exportName);
  if (!targetBinding) return undefined;
  const targetSymbols = ctx.getSymbolsByFile(moduleFile.id) as ResolveSymbol[];
  const enclosing = findTsHandlerEnclosing(targetSource, targetSymbols, imp.exportName);
  if (!enclosing) return undefined;
  return { sym: enclosing, role: targetBinding.kind };
}

/**
 * Resolves the identifier used at an `executeChild(x)` / `startChild(x)` call site to the child
 * workflow's exported function, same-file or cross-file via a relative import.
 */
function resolveTsWorkflowTarget(
  ctx: ResolveContext,
  file: { path: string },
  symbols: ResolveSymbol[],
  source: string,
  tsFilesByPath: Map<string, { id: number; path: string }>,
  identifier: string,
): ResolveSymbol | undefined {
  const sameFile = symbols.find((s) => s.kind === 'function' && s.name === identifier);
  if (sameFile) return sameFile;

  const imp = findTsNamedImports(source).find((i) => i.localName === identifier);
  if (!imp) return undefined;
  const moduleFile = resolveTsModulePath(file.path, imp.modulePath, tsFilesByPath);
  if (!moduleFile) return undefined;
  const targetSymbols = ctx.getSymbolsByFile(moduleFile.id) as ResolveSymbol[];
  return targetSymbols.find((s) => s.kind === 'function' && s.name === imp.exportName);
}

export class TemporalPlugin implements FrameworkPlugin {
  manifest = {
    name: 'temporal',
    version: '1.0.0',
    priority: 30,
    category: 'messaging' as const,
  };

  /**
   * Per-file extraction cache populated by `extractNodes`, consumed by
   * `resolveEdges` so it doesn't re-run the same regex extraction over
   * every file's source a second time. Falls back to re-extracting when a
   * file's entry is missing (e.g. an incremental reindex that only called
   * `extractNodes` for a subset of files), so this is a pure perf cache —
   * never a correctness dependency.
   */
  private readonly pyGoRefCache = new Map<string, TemporalSymbolRef[]>();
  private readonly javaExtractionCache = new Map<string, JavaInterfaceExtraction>();

  detect(ctx: ProjectContext): boolean {
    return hasDependency(
      ctx.allDependencies,
      (name) =>
        name.startsWith('@temporalio/') ||
        name === 'temporalio' ||
        name === 'io.temporal:temporal-sdk' ||
        name === 'go.temporal.io/sdk',
    );
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'temporal_executes_activity',
          category: 'messaging',
          directed: true,
          description: 'A Temporal workflow invokes an activity',
        },
        {
          name: 'temporal_sends_signal',
          category: 'messaging',
          directed: true,
          description: 'A caller sends a signal to a running workflow',
        },
        {
          name: 'temporal_executes_child_workflow',
          category: 'messaging',
          directed: true,
          description: 'A workflow starts a child workflow',
        },
        {
          name: 'temporal_sends_update',
          category: 'messaging',
          directed: true,
          description: 'A caller sends an update to a running workflow',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer | string,
    language: string,
  ): ReturnType<NonNullable<FrameworkPlugin['extractNodes']>> {
    const source = content.toString();
    let refs: TemporalSymbolRef[] = [];

    if (language === 'python') {
      refs = extractTemporalPython(source);
      this.pyGoRefCache.set(filePath, refs);
    } else if (TS_EXTENSIONS.has(language)) {
      refs = extractTemporalTypeScript(source);
    } else if (language === 'java') {
      const extraction = extractTemporalJava(source);
      this.javaExtractionCache.set(filePath, extraction);
      refs = extraction.refs;
    } else if (language === 'go') {
      refs = extractTemporalGo(source);
      this.pyGoRefCache.set(filePath, refs);
    } else {
      return ok({ status: 'ok', symbols: [] } satisfies FileParseResult);
    }

    if (refs.length === 0) {
      return ok({ status: 'ok', symbols: [] } satisfies FileParseResult);
    }

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: refs.map((ref) => ({
        method: routeMethodFor(ref.role),
        uri: ref.name,
        line: ref.line,
      })),
    };
    result.frameworkRole = refs.some((r) => r.role === 'workflow')
      ? 'temporal_workflow'
      : 'temporal_activity';
    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): ReturnType<NonNullable<FrameworkPlugin['resolveEdges']>> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    const pyActivityIndex = new Map<string, ResolveSymbol[]>();
    const pySignalIndex = new Map<string, ResolveSymbol[]>();
    const pyUpdateIndex = new Map<string, ResolveSymbol[]>();
    const pyWorkflowIndex = new Map<string, ResolveSymbol[]>();
    // Dispatch call sites very commonly pass an imported UPPER_CASE string constant
    // (e.g. `PLAN_EVALUATION_ACTIVITY`) instead of a direct reference — this indexes
    // every module-level Python constant project-wide so the second pass can resolve
    // such an identifier to its literal value before giving up on a by-name lookup.
    const pyConstantIndex = new Map<string, string>();
    const goActivityIndex = new Map<string, ResolveSymbol[]>();
    const goWorkflowIndex = new Map<string, ResolveSymbol[]>();
    const goSignalIndex = new Map<string, ResolveSymbol[]>();
    const javaInterfaceMethodIndex = new Map<
      string,
      Map<string, { sym: ResolveSymbol; role: TemporalRole }>
    >();
    const tsFilesByPath = new Map<string, { id: number; path: string }>();

    for (const file of allFiles) {
      if (TS_EXTENSIONS.has(file.language ?? '')) {
        tsFilesByPath.set(file.path, { id: file.id, path: file.path });
      }
    }

    for (const file of allFiles) {
      if (file.language !== 'python' && file.language !== 'go' && file.language !== 'java')
        continue;

      if (file.language === 'java') {
        const cached = this.javaExtractionCache.get(file.path);
        const source = cached ? undefined : ctx.readFile(file.path);
        if (!cached && !source) continue;
        const symbols = ctx.getSymbolsByFile(file.id) as ResolveSymbol[];
        const { interfaceMethods } = cached ?? extractTemporalJava(source!);
        for (const [interfaceName, methods] of interfaceMethods) {
          const methodMap =
            javaInterfaceMethodIndex.get(interfaceName) ??
            new Map<string, { sym: ResolveSymbol; role: TemporalRole }>();
          for (const [methodName, role] of methods) {
            const sym = symbols.find((s) => s.name === methodName && s.kind === 'method');
            if (sym) methodMap.set(methodName, { sym, role });
          }
          if (methodMap.size > 0) javaInterfaceMethodIndex.set(interfaceName, methodMap);
        }
        continue;
      }

      const cachedRefs = this.pyGoRefCache.get(file.path);
      const source = cachedRefs ? undefined : ctx.readFile(file.path);
      if (!cachedRefs && !source) continue;
      const symbols = ctx.getSymbolsByFile(file.id) as ResolveSymbol[];

      if (file.language === 'python') {
        const refs = cachedRefs ?? extractTemporalPython(source!);
        for (const ref of refs) {
          if (ref.role === 'activity') {
            const sym = symbols.find((s) => s.name === ref.name && s.kind === 'function');
            if (!sym) continue;
            const existing = pyActivityIndex.get(ref.name) ?? [];
            existing.push(sym);
            pyActivityIndex.set(ref.name, existing);
          } else if (ref.role === 'signal' || ref.role === 'update') {
            const sym = symbols.find(
              (s) => s.name === ref.name && (s.kind === 'method' || s.kind === 'function'),
            );
            if (!sym) continue;
            const idx = ref.role === 'signal' ? pySignalIndex : pyUpdateIndex;
            const existing = idx.get(ref.name) ?? [];
            existing.push(sym);
            idx.set(ref.name, existing);
          } else if (ref.role === 'workflow') {
            const sym = symbols.find(
              (s) =>
                s.name === ref.name &&
                (s.kind === 'class' || s.kind === 'method' || s.kind === 'function'),
            );
            if (!sym) continue;
            const existing = pyWorkflowIndex.get(ref.name) ?? [];
            existing.push(sym);
            pyWorkflowIndex.set(ref.name, existing);
          }
        }
      } else if (file.language === 'go') {
        const refs = cachedRefs ?? extractTemporalGo(source!);
        for (const ref of refs) {
          if (ref.role === 'activity') {
            const sym = symbols.find((s) => s.name === ref.name && s.kind === 'function');
            if (!sym) continue;
            const existing = goActivityIndex.get(ref.name) ?? [];
            existing.push(sym);
            goActivityIndex.set(ref.name, existing);
          } else if (ref.role === 'workflow') {
            const sym = symbols.find((s) => s.name === ref.name && s.kind === 'function');
            if (!sym) continue;
            const existing = goWorkflowIndex.get(ref.name) ?? [];
            existing.push(sym);
            goWorkflowIndex.set(ref.name, existing);
          } else if (ref.role === 'signal') {
            const enclosing = findEnclosingSymbol(symbols, ref.line, ['function']);
            if (!enclosing) continue;
            const existing = goSignalIndex.get(ref.name) ?? [];
            existing.push(enclosing);
            goSignalIndex.set(ref.name, existing);
          }
        }
      }
    }

    for (const file of allFiles) {
      if (file.language !== 'python') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      for (const [name, value] of extractPythonConstants(source)) {
        if (!pyConstantIndex.has(name)) pyConstantIndex.set(name, value);
      }
    }

    for (const file of allFiles) {
      const isRelevant =
        file.language === 'python' ||
        file.language === 'go' ||
        file.language === 'java' ||
        TS_EXTENSIONS.has(file.language ?? '');
      if (!isRelevant) continue;

      const source = ctx.readFile(file.path);
      if (!source) continue;
      const symbols = ctx.getSymbolsByFile(file.id) as ResolveSymbol[];

      if (file.language === 'python') {
        // Activities/signals/updates are referenced as `Type.leaf_name`, where `leaf_name`
        // (the decorated function/method) is the meaningful identity — resolve by last segment.
        // Child workflows are referenced the same dotted way (`ShippingWorkflow.run`), but the
        // *class* is the workflow's identity, not its `run` method (every workflow has one,
        // so leaf-name resolution would collide across every workflow in the file) — resolve
        // by first segment instead.
        for (const { re, index, edgeType, resolve } of [
          {
            re: PY_EXECUTE_ACTIVITY_RE,
            index: pyActivityIndex,
            edgeType: 'temporal_executes_activity',
            resolve: (raw: string) => raw.split('.').pop()!,
          },
          {
            re: PY_SEND_SIGNAL_RE,
            index: pySignalIndex,
            edgeType: 'temporal_sends_signal',
            resolve: (raw: string) => raw.split('.').pop()!,
          },
          {
            re: PY_EXECUTE_CHILD_WORKFLOW_RE,
            index: pyWorkflowIndex,
            edgeType: 'temporal_executes_child_workflow',
            resolve: (raw: string) => raw.split('.')[0],
          },
          {
            re: PY_SEND_UPDATE_RE,
            index: pyUpdateIndex,
            edgeType: 'temporal_sends_update',
            resolve: (raw: string) => raw.split('.').pop()!,
          },
        ]) {
          const r = new RegExp(re.source, 'g');
          let m: RegExpExecArray | null;
          while ((m = r.exec(source)) !== null) {
            const identifier = resolve(m[1]);
            let targets = index.get(identifier);
            if (!targets) {
              const constValue = pyConstantIndex.get(identifier);
              if (constValue) targets = index.get(constValue);
            }
            if (!targets) continue;
            const line = lineOfSource(source, m.index);
            const enclosing = findEnclosingSymbol(symbols, line, ['function', 'method']);
            if (!enclosing) continue;
            for (const target of targets) edges.push(makeEdge(enclosing.id, target.id, edgeType));
          }
        }
      } else if (file.language === 'go') {
        for (const { re, index, edgeType } of [
          {
            re: GO_EXECUTE_ACTIVITY_RE,
            index: goActivityIndex,
            edgeType: 'temporal_executes_activity',
          },
          {
            re: GO_EXECUTE_CHILD_WORKFLOW_RE,
            index: goWorkflowIndex,
            edgeType: 'temporal_executes_child_workflow',
          },
        ]) {
          const r = new RegExp(re.source, 'g');
          let m: RegExpExecArray | null;
          while ((m = r.exec(source)) !== null) {
            const raw = m[1] ?? m[2];
            const targets = index.get(resolveGoIdentifier(raw));
            if (!targets) continue;
            const line = lineOfSource(source, m.index);
            const enclosing = findEnclosingSymbol(symbols, line, ['function']);
            if (!enclosing) continue;
            for (const target of targets) edges.push(makeEdge(enclosing.id, target.id, edgeType));
          }
        }

        const signalRe = new RegExp(GO_SIGNAL_EXTERNAL_RE.source, 'g');
        let sm: RegExpExecArray | null;
        while ((sm = signalRe.exec(source)) !== null) {
          const targets = goSignalIndex.get(sm[1]);
          if (!targets) continue;
          const line = lineOfSource(source, sm.index);
          const enclosing = findEnclosingSymbol(symbols, line, ['function']);
          if (!enclosing) continue;
          for (const target of targets)
            edges.push(makeEdge(enclosing.id, target.id, 'temporal_sends_signal'));
        }
      } else if (file.language === 'java') {
        for (const { re, allowWorkflowRole } of [
          { re: JAVA_NEW_ACTIVITY_STUB_RE, allowWorkflowRole: false },
          { re: JAVA_NEW_CHILD_WORKFLOW_STUB_RE, allowWorkflowRole: true },
          { re: JAVA_NEW_EXTERNAL_WORKFLOW_STUB_RE, allowWorkflowRole: false },
        ]) {
          const stubRe = new RegExp(re.source, 'g');
          const stubs: { varName: string; interfaceName: string }[] = [];
          let m: RegExpExecArray | null;
          while ((m = stubRe.exec(source)) !== null) {
            stubs.push({ varName: m[2], interfaceName: m[3] });
          }
          for (const stub of stubs) {
            const methodMap = javaInterfaceMethodIndex.get(stub.interfaceName);
            if (!methodMap) continue;
            const callRe = new RegExp(
              `\\b${escapeRegExp(stub.varName)}\\s*\\.\\s*(\\w+)\\s*\\(`,
              'g',
            );
            let cm: RegExpExecArray | null;
            while ((cm = callRe.exec(source)) !== null) {
              const entry = methodMap.get(cm[1]);
              if (!entry) continue;
              if (entry.role === 'workflow' && !allowWorkflowRole) continue;
              const edgeType = edgeTypeForRole(entry.role);
              if (!edgeType) continue;
              const line = lineOfSource(source, cm.index);
              const enclosing = findEnclosingSymbol(symbols, line, ['method']);
              if (!enclosing) continue;
              edges.push(makeEdge(enclosing.id, entry.sym.id, edgeType));
            }
          }
        }
      } else if (TS_EXTENSIONS.has(file.language ?? '')) {
        for (const proxy of findTsActivitiesProxies(source)) {
          const moduleFile = resolveTsModulePath(file.path, proxy.modulePath, tsFilesByPath);
          if (!moduleFile) continue;
          const moduleSymbols = ctx.getSymbolsByFile(moduleFile.id) as ResolveSymbol[];
          const exportsByName = new Map(
            moduleSymbols.filter((s) => s.kind === 'function').map((s) => [s.name, s]),
          );

          if (proxy.binding) {
            const callRe = new RegExp(
              `\\b${escapeRegExp(proxy.binding)}\\s*\\.\\s*(\\w+)\\s*\\(`,
              'g',
            );
            let cm: RegExpExecArray | null;
            while ((cm = callRe.exec(source)) !== null) {
              const target = exportsByName.get(cm[1]);
              if (!target) continue;
              const line = lineOfSource(source, cm.index);
              const enclosing = findEnclosingSymbol(symbols, line, ['function']);
              if (!enclosing) continue;
              edges.push(makeEdge(enclosing.id, target.id, 'temporal_executes_activity'));
            }
          } else if (proxy.names) {
            for (const { exportName, localName } of proxy.names) {
              const target = exportsByName.get(exportName);
              if (!target) continue;
              const callRe = new RegExp(`(?<!\\.)\\b${escapeRegExp(localName)}\\s*\\(`, 'g');
              let cm: RegExpExecArray | null;
              while ((cm = callRe.exec(source)) !== null) {
                const line = lineOfSource(source, cm.index);
                const enclosing = findEnclosingSymbol(symbols, line, ['function']);
                if (!enclosing) continue;
                edges.push(makeEdge(enclosing.id, target.id, 'temporal_executes_activity'));
              }
            }
          }
        }

        for (const re of [TS_SEND_SIGNAL_RE, TS_SEND_UPDATE_RE]) {
          const sendRe = new RegExp(re.source, 'g');
          let m: RegExpExecArray | null;
          while ((m = sendRe.exec(source)) !== null) {
            const resolved = resolveTsSendTarget(ctx, file, source, symbols, tsFilesByPath, m[1]);
            if (!resolved) continue;
            const edgeType = edgeTypeForRole(resolved.role);
            if (!edgeType) continue;
            const line = lineOfSource(source, m.index);
            const enclosing = findEnclosingSymbol(symbols, line, ['function']);
            if (!enclosing) continue;
            edges.push(makeEdge(enclosing.id, resolved.sym.id, edgeType));
          }
        }

        const childRe = new RegExp(TS_EXECUTE_CHILD_RE.source, 'g');
        let cm: RegExpExecArray | null;
        while ((cm = childRe.exec(source)) !== null) {
          const target = resolveTsWorkflowTarget(ctx, file, symbols, source, tsFilesByPath, cm[1]);
          if (!target) continue;
          const line = lineOfSource(source, cm.index);
          const enclosing = findEnclosingSymbol(symbols, line, ['function']);
          if (!enclosing) continue;
          edges.push(makeEdge(enclosing.id, target.id, 'temporal_executes_child_workflow'));
        }
      }
    }

    return ok(edges);
  }
}
