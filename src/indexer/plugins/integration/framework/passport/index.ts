/**
 * PassportPlugin — detects passport-based authentication. Extracts strategy
 * registrations (`passport.use(new XStrategy(...))`), NestJS-style strategy
 * classes (`extends PassportStrategy(Strategy)`), and consumer call sites
 * (`passport.authenticate('jwt')`, `AuthGuard('jwt')`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { stripJsComments } from '../../_shared/strip-comments.js';

/**
 * Match: passport.use(new JwtStrategy(...)) — captures strategy class.
 * Also matches chained calls: `passport.use(x).use(new JwtStrategy(...))`,
 * where the second `.use(` is preceded by `)` instead of `passport`.
 */
const PASSPORT_USE_NEW_RE =
  /(?:passport|\))\s*\.\s*use\s*\(\s*(?:['"`](\w+)['"`]\s*,\s*)?new\s+(\w+)\s*\(/g;

/** Match: passport.use('local', strategyVar) — bare name + symbol */
const PASSPORT_USE_VAR_RE =
  /(?:passport|\))\s*\.\s*use\s*\(\s*['"`](\w+)['"`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;

/** Match: class JwtStrategy extends PassportStrategy(Strategy[, 'jwt']) */
const NEST_STRATEGY_RE =
  /class\s+(\w+)\s+extends\s+PassportStrategy\s*\(\s*(\w+)(?:\s*,\s*['"`]([^'"`]+)['"`])?\s*\)/g;

/** Match: passport.authenticate('jwt' | ['jwt','session']) */
const AUTHENTICATE_RE =
  /passport\s*\.\s*authenticate\s*\(\s*(?:\[\s*([^\]]+)\s*\]|['"`]([^'"`]+)['"`])/g;

/** Match: AuthGuard('jwt')  (NestJS) */
const AUTH_GUARD_RE = /AuthGuard\s*\(\s*(?:\[\s*([^\]]+)\s*\]|['"`]([^'"`]+)['"`])\s*\)/g;

/** Match: passport.serializeUser / deserializeUser */
const SERIALIZER_RE = /passport\s*\.\s*(serializeUser|deserializeUser)\s*\(/g;

export interface PassportStrategyDef {
  /** Strategy class instantiated (e.g. JwtStrategy) or extended (NestJS class). */
  className: string;
  /** Optional registered name (e.g. 'jwt', 'local'). */
  registeredName?: string;
  /** Style: classic passport.use(new X()) vs NestJS extends PassportStrategy(...). */
  style: 'passport_use' | 'nest_extends';
  /** For NestJS extends-style: the imported base strategy (Strategy from passport-jwt). */
  baseStrategy?: string;
}

export interface PassportConsumer {
  /** 'authenticate' = passport.authenticate, 'guard' = NestJS AuthGuard */
  kind: 'authenticate' | 'guard';
  /** Strategy names referenced (one or more). */
  strategies: string[];
}

export interface PassportFileSummary {
  strategies: PassportStrategyDef[];
  consumers: PassportConsumer[];
  hasSerializers: boolean;
}

function splitNames(list: string): string[] {
  return list
    .split(',')
    .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
    .filter(Boolean);
}

/** Extract all passport-related signals from a single source file. */
export function extractPassportSignals(source: string): PassportFileSummary {
  // Strip JS comments so things like `// passport.use(new FakeStrategy())`
  // don't get mistaken for real registrations. String literals are preserved
  // because we extract strategy names from them (e.g. `AuthGuard('jwt')`).
  source = stripJsComments(source);

  const strategies: PassportStrategyDef[] = [];
  const consumers: PassportConsumer[] = [];

  let m: RegExpExecArray | null;

  const useNewRe = new RegExp(PASSPORT_USE_NEW_RE.source, 'g');
  while ((m = useNewRe.exec(source)) !== null) {
    strategies.push({
      className: m[2],
      registeredName: m[1],
      style: 'passport_use',
    });
  }

  const useVarRe = new RegExp(PASSPORT_USE_VAR_RE.source, 'g');
  while ((m = useVarRe.exec(source)) !== null) {
    strategies.push({
      className: m[2],
      registeredName: m[1],
      style: 'passport_use',
    });
  }

  const nestRe = new RegExp(NEST_STRATEGY_RE.source, 'g');
  while ((m = nestRe.exec(source)) !== null) {
    strategies.push({
      className: m[1],
      baseStrategy: m[2],
      registeredName: m[3],
      style: 'nest_extends',
    });
  }

  const authRe = new RegExp(AUTHENTICATE_RE.source, 'g');
  while ((m = authRe.exec(source)) !== null) {
    const names = m[1] ? splitNames(m[1]) : m[2] ? [m[2]] : [];
    if (names.length > 0) consumers.push({ kind: 'authenticate', strategies: names });
  }

  const guardRe = new RegExp(AUTH_GUARD_RE.source, 'g');
  while ((m = guardRe.exec(source)) !== null) {
    const names = m[1] ? splitNames(m[1]) : m[2] ? [m[2]] : [];
    if (names.length > 0) consumers.push({ kind: 'guard', strategies: names });
  }

  const hasSerializers = SERIALIZER_RE.test(source);

  return { strategies, consumers, hasSerializers };
}

export class PassportPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'passport',
    version: '1.0.0',
    priority: 30,
    category: 'framework',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    const has = (deps: Record<string, string> | undefined) =>
      !!deps &&
      ('passport' in deps ||
        '@nestjs/passport' in deps ||
        Object.keys(deps).some((k) => k.startsWith('passport-')));

    if (ctx.packageJson) {
      const merged = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (has(merged)) return true;
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const merged = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      return has(merged);
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'passport_strategy',
          category: 'passport',
          description: 'A passport strategy class registration',
        },
        {
          name: 'passport_authenticates',
          category: 'passport',
          description: 'Code path guarded by a passport strategy',
        },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    if (
      !/passport/.test(source) &&
      !/PassportStrategy/.test(source) &&
      !/AuthGuard\s*\(/.test(source)
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    const summary = extractPassportSignals(source);
    if (
      summary.strategies.length === 0 &&
      summary.consumers.length === 0 &&
      !summary.hasSerializers
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      routes: [],
      metadata: { passport: summary },
    };

    if (summary.strategies.length > 0) {
      result.frameworkRole = 'passport_strategy';
      for (const s of summary.strategies) {
        result.routes!.push({
          method: 'STRATEGY',
          uri: `passport:${s.registeredName ?? s.className}`,
          metadata: {
            className: s.className,
            registeredName: s.registeredName,
            baseStrategy: s.baseStrategy,
            style: s.style,
          },
        });
      }
    }

    if (summary.consumers.length > 0) {
      result.frameworkRole = result.frameworkRole ?? 'passport_consumer';
      for (const c of summary.consumers) {
        for (const name of c.strategies) {
          result.routes!.push({
            method: c.kind === 'guard' ? 'GUARD' : 'AUTH',
            uri: `passport:${name}`,
            metadata: { kind: c.kind },
          });
        }
      }
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    const allFiles = ctx.getAllFiles();

    /**
     * registered name (e.g. 'jwt') → ALL matching strategy targets. We keep
     * every match because conflicting registrations are an application-level
     * mistake, not something the index should silently choose for. Consumers
     * get one edge per candidate, marked `ambiguous` when >1.
     */
    const strategyByRegName = new Map<string, { id: number; className: string }[]>();

    /**
     * Per-file summaries keyed by file id. Holds the parsed signals plus the
     * file-local class symbols (owners + a primary class for consumer linkage).
     * We collect everything in one pass to avoid hitting the symbol store
     * twice per file in subsequent passes.
     */
    const summariesPerFile = new Map<
      number,
      {
        summary: PassportFileSummary;
        ownerByName: Map<string, { id: number }>;
        firstClass?: { id: number };
      }
    >();

    for (const file of allFiles) {
      if (file.language !== 'typescript' && file.language !== 'javascript') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      if (
        !/passport/.test(source) &&
        !/PassportStrategy/.test(source) &&
        !/AuthGuard\s*\(/.test(source)
      ) {
        continue;
      }
      const ownerByName = new Map<string, { id: number }>();
      let firstClass: { id: number } | undefined;
      for (const sym of ctx.getSymbolsByFile(file.id)) {
        if (sym.kind === 'class') {
          ownerByName.set(sym.name, { id: sym.id });
          if (!firstClass) firstClass = { id: sym.id };
        }
      }
      summariesPerFile.set(file.id, {
        summary: extractPassportSignals(source),
        ownerByName,
        firstClass,
      });
    }

    const recordRegName = (name: string, target: { id: number; className: string }) => {
      const list = strategyByRegName.get(name);
      if (list) list.push(target);
      else strategyByRegName.set(name, [target]);
    };

    // Second pass: register strategies + emit passport_strategy self-loops.
    for (const [, { summary, ownerByName }] of summariesPerFile) {
      for (const s of summary.strategies) {
        const cls = ownerByName.get(s.className);
        if (!cls) continue;
        const fallback = s.className.replace(/Strategy$/, '').toLowerCase();
        if (fallback) recordRegName(fallback, { id: cls.id, className: s.className });
        if (s.registeredName && s.registeredName !== fallback) {
          recordRegName(s.registeredName, { id: cls.id, className: s.className });
        }
        edges.push({
          sourceNodeType: 'symbol',
          sourceRefId: cls.id,
          targetNodeType: 'symbol',
          targetRefId: cls.id,
          edgeType: 'passport_strategy',
          resolution: 'ast_inferred',
          metadata: {
            registeredName: s.registeredName,
            style: s.style,
            baseStrategy: s.baseStrategy,
          },
        });
      }
    }

    // Third pass: link consumer file's primary class to the strategy class(es) it guards.
    for (const [, { summary, firstClass: consumerClass }] of summariesPerFile) {
      if (summary.consumers.length === 0) continue;
      if (!consumerClass) continue;
      for (const c of summary.consumers) {
        for (const name of c.strategies) {
          const targets = strategyByRegName.get(name);
          if (!targets || targets.length === 0) continue;
          for (const target of targets) {
            edges.push({
              sourceNodeType: 'symbol',
              sourceRefId: consumerClass.id,
              targetNodeType: 'symbol',
              targetRefId: target.id,
              edgeType: 'passport_authenticates',
              resolution: 'ast_inferred',
              metadata: {
                kind: c.kind,
                strategyName: name,
                strategyClass: target.className,
                ambiguous: targets.length > 1 ? targets.length : undefined,
              },
            });
          }
        }
      }
    }

    return ok(edges);
  }
}
