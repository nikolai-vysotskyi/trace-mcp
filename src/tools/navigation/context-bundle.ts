/**
 * get_context_bundle — symbol source + import dependencies + optional callers,
 * packed within a token budget. Deduplicates shared imports for batch queries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { err, ok } from 'neverthrow';
import type { FileRow, Store, SymbolRow } from '../../db/store.js';
import type { TraceMcpResult } from '../../errors.js';
import type { ContextItem } from '../../scoring/assembly.js';
import {
  assembleStructuredContext,
  renderStructuredContext,
} from '../../scoring/structured-assembly.js';
import { readByteRange } from '../../utils/source-reader.js';

/** Import-category edge types to follow for dependency resolution */
const IMPORT_EDGES = new Set(['esm_imports', 'imports', 'py_imports', 'py_reexports']);

/** Call/reference edge types for caller resolution */
const CALL_EDGES = new Set([
  'calls',
  'references',
  'dispatches',
  'routes_to',
  'validates_with',
  'nest_injects',
  'graphql_resolves',
]);

interface BundleSymbolItem {
  symbol_id: string;
  name: string;
  kind: string;
  file: string;
  line: number | null;
  /**
   * Are this symbol's bytes actually in `content`? False for the entries the
   * budget (or the prose rule below) reduced to a signature. Listing a symbol
   * and shipping its source are different claims — TRA-1090 cost us three days
   * because a coverage metric could not tell them apart.
   */
  source_included: boolean;
}

interface ContextBundleResult {
  primary: BundleSymbolItem[];
  dependencies: BundleSymbolItem[];
  callers: BundleSymbolItem[];
  totalTokens: number;
  truncated: boolean;
  content?: string; // markdown output when output_format = 'markdown'
}

/** Cache for batched file reads — avoids re-opening the same file for each symbol */
class FileReadCache {
  private cache = new Map<number, Buffer | null>();

  constructor(private rootPath: string) {}

  readSymbolSource(sym: SymbolRow, file: FileRow): string | undefined {
    let buf = this.cache.get(file.id);
    if (buf === undefined) {
      try {
        // TRA-1090: this was a bare `require('node:fs')`. It worked in the
        // shipped build (createRequire banner) and under vitest (which defines
        // `require` in every module it transforms), but any real-ESM consumer —
        // the benchmarks under tsx, `pnpm serve` — threw ReferenceError into
        // the catch below and got a bundle with no source at all, silently.
        const absPath = path.resolve(this.rootPath, file.path);
        buf = fs.readFileSync(absPath);
      } catch {
        buf = null;
      }
      this.cache.set(file.id, buf);
    }
    if (!buf || sym.byte_start == null || sym.byte_end == null) return undefined;
    if (file.gitignored) return '[gitignored]';
    return buf.subarray(sym.byte_start, sym.byte_end).toString('utf-8');
  }
}

function readSource(sym: SymbolRow, file: FileRow, rootPath: string): string | undefined {
  try {
    const absPath = path.resolve(rootPath, file.path);
    return readByteRange(absPath, sym.byte_start, sym.byte_end, !!file.gitignored) ?? undefined;
  } catch {
    return undefined;
  }
}

function _toContextItem(
  sym: SymbolRow,
  file: FileRow,
  rootPath: string,
  score: number,
): ContextItem {
  return {
    id: sym.symbol_id,
    score,
    source: readSource(sym, file, rootPath),
    signature: sym.signature ?? undefined,
    metadata: `[${sym.kind}] ${sym.fqn ?? sym.name} — ${file.path}`,
  };
}

function toContextItemCached(
  sym: SymbolRow,
  file: FileRow,
  cache: FileReadCache,
  score: number,
  signatureOnly: boolean,
): ContextItem {
  return {
    id: sym.symbol_id,
    score,
    source: signatureOnly ? undefined : cache.readSymbolSource(sym, file),
    signature: sym.signature ?? undefined,
    metadata: `[${sym.kind}] ${sym.fqn ?? sym.name} — ${file.path}`,
  };
}

/**
 * TRA-1141: is this symbol's source already inside another one we are emitting?
 *
 * `__module__:foo` spans the whole file and `note:Readme` spans the whole
 * document, so asking for one of those together with the functions or headings
 * inside it shipped the same bytes twice. Changed-symbol callers (review
 * bundles, `bench-pr-context`) hit this on every commit that touches top-level
 * code. The container is kept — its text is a superset — and the contained
 * entry stays in the reported symbol list, just without a second copy of the
 * source. Equal spans keep the earlier entry.
 */
function isContainedInAnother(entries: Array<{ sym: SymbolRow }>, i: number): boolean {
  const e = entries[i].sym;
  if (e.byte_start == null || e.byte_end == null) return false;
  return entries.some(({ sym: o }, j) => {
    if (j === i || o.file_id !== e.file_id) return false;
    if (o.byte_start == null || o.byte_end == null) return false;
    if (o.byte_start > e.byte_start || o.byte_end < e.byte_end) return false;
    const sameSpan = o.byte_start === e.byte_start && o.byte_end === e.byte_end;
    return sameSpan ? j < i : true;
  });
}

/**
 * A `__module__:foo` namespace spans its whole file. As a *primary* that is
 * what the caller asked for, but as a dependency or a caller it means "this
 * file mentions your symbol somewhere" — and inlining a whole test file to say
 * so cost more than the review's entire baseline (axios#11039). It stays listed.
 */
function isWholeFile(sym: SymbolRow, file: FileRow): boolean {
  if (sym.byte_start == null || sym.byte_end == null || file.byte_length == null) return false;
  return sym.byte_start === 0 && sym.byte_end >= file.byte_length;
}

function toBundleItem(sym: SymbolRow, file: FileRow, sourceIncluded: boolean): BundleSymbolItem {
  return {
    symbol_id: sym.symbol_id,
    name: sym.name,
    kind: sym.kind,
    file: file.path,
    line: sym.line_start,
    source_included: sourceIncluded,
  };
}

export function getContextBundle(
  store: Store,
  rootPath: string,
  opts: {
    symbolIds: string[];
    fqn?: string;
    includeCallers?: boolean;
    tokenBudget?: number;
    outputFormat?: 'json' | 'markdown';
  },
): TraceMcpResult<ContextBundleResult> {
  const budget = opts.tokenBudget ?? 8000;
  const includeCallers = opts.includeCallers ?? false;

  // Resolve primary symbols
  const ids = opts.symbolIds.length > 0 ? opts.symbolIds : [];
  if (ids.length === 0 && opts.fqn) {
    const sym = store.getSymbolByFqn(opts.fqn);
    if (sym) ids.push(sym.symbol_id);
  }

  if (ids.length === 0) {
    return err({
      code: 'VALIDATION_ERROR' as const,
      message: 'Provide symbol_id, symbol_ids, or fqn',
    });
  }

  const primarySymbols: Array<{ sym: SymbolRow; file: FileRow }> = [];
  for (const id of ids) {
    const sym =
      store.getSymbolBySymbolId(id) ?? (id.includes('\\') ? store.getSymbolByFqn(id) : undefined);
    if (!sym) {
      return err({ code: 'NOT_FOUND' as const, id });
    }
    const file = store.getFileById(sym.file_id);
    if (!file) {
      return err({ code: 'NOT_FOUND' as const, id: `file for ${id}` });
    }
    primarySymbols.push({ sym, file });
  }

  // Get node IDs for primaries
  const primaryInternalIds = primarySymbols.map((p) => p.sym.id);
  const primaryNodeMap = store.getNodeIdsBatch('symbol', primaryInternalIds);
  const primaryNodeIds = primaryInternalIds
    .map((id) => primaryNodeMap.get(id))
    .filter((n): n is number => n != null);

  // Collect import dependencies (deduplicated across all primaries)
  const seenDepIds = new Set(primaryInternalIds);
  const depNodeIds: number[] = [];

  for (const nodeId of primaryNodeIds) {
    const edges = store.getOutgoingEdges(nodeId);
    for (const edge of edges) {
      if (!IMPORT_EDGES.has(edge.edge_type_name)) continue;
      depNodeIds.push(edge.target_node_id);
    }
  }

  // Resolve dep nodes to symbols
  const depSymbols: Array<{ sym: SymbolRow; file: FileRow }> = [];
  if (depNodeIds.length > 0) {
    const uniqueDepNodeIds = [...new Set(depNodeIds)];
    const nodeRefs = store.getNodeRefsBatch(uniqueDepNodeIds);
    const symbolRefIds: number[] = [];
    const fileRefIds: number[] = [];

    for (const [, ref] of nodeRefs) {
      if (ref.nodeType === 'symbol') symbolRefIds.push(ref.refId);
      else if (ref.nodeType === 'file') fileRefIds.push(ref.refId);
    }

    // Resolve symbol-type deps
    if (symbolRefIds.length > 0) {
      const symMap = store.getSymbolsByIds(symbolRefIds);
      const fIds = [...new Set([...symMap.values()].map((s) => s.file_id))];
      const fMap = store.getFilesByIds(fIds);

      for (const [, sym] of symMap) {
        if (seenDepIds.has(sym.id)) continue;
        seenDepIds.add(sym.id);
        const file = fMap.get(sym.file_id);
        if (file) depSymbols.push({ sym, file });
      }
    }

    // For file-type deps, grab their top-level exported symbols (batched)
    if (fileRefIds.length > 0) {
      const depFileMap = store.getFilesByIds(fileRefIds);
      const placeholders = fileRefIds.map(() => '?').join(',');
      const allFileSyms = store.db
        .prepare(`SELECT * FROM symbols WHERE file_id IN (${placeholders}) AND parent_id IS NULL`)
        .all(...fileRefIds) as SymbolRow[];
      for (const sym of allFileSyms) {
        if (seenDepIds.has(sym.id)) continue;
        seenDepIds.add(sym.id);
        const file = depFileMap.get(sym.file_id);
        if (file) depSymbols.push({ sym, file });
      }
    }
  }

  // Optionally collect callers
  const callerSymbols: Array<{ sym: SymbolRow; file: FileRow }> = [];
  if (includeCallers) {
    const callerNodeIds: number[] = [];
    for (const nodeId of primaryNodeIds) {
      const edges = store.getIncomingEdges(nodeId);
      for (const edge of edges) {
        if (!CALL_EDGES.has(edge.edge_type_name)) continue;
        callerNodeIds.push(edge.source_node_id);
      }
    }

    if (callerNodeIds.length > 0) {
      const uniqueCallerNodeIds = [...new Set(callerNodeIds)];
      const nodeRefs = store.getNodeRefsBatch(uniqueCallerNodeIds);
      const symbolRefIds = [...nodeRefs.values()]
        .filter((r) => r.nodeType === 'symbol')
        .map((r) => r.refId);

      if (symbolRefIds.length > 0) {
        const symMap = store.getSymbolsByIds(symbolRefIds);
        const fIds = [...new Set([...symMap.values()].map((s) => s.file_id))];
        const fMap = store.getFilesByIds(fIds);

        for (const [, sym] of symMap) {
          if (seenDepIds.has(sym.id)) continue;
          seenDepIds.add(sym.id);
          const file = fMap.get(sym.file_id);
          if (file) callerSymbols.push({ sym, file });
        }
      }
    }
  }

  // Assemble within token budget using structured assembly
  // Use file read cache to avoid re-reading the same file for multiple symbols
  const fileCache = new FileReadCache(rootPath);

  // Primary symbols get full source, unless an enclosing primary already
  // carries their bytes (TRA-1141) — then the container alone is emitted.
  const primaryItems: ContextItem[] = primarySymbols
    .map((p, i) =>
      isContainedInAnother(primarySymbols, i)
        ? null
        : toContextItemCached(p.sym, p.file, fileCache, 1.0 - i * 0.01, false),
    )
    .filter((x): x is ContextItem => x !== null);
  // Dependencies: top N get full source, rest get signature-only (lazy loading)
  // This avoids reading source for deps that will be truncated by the assembler anyway
  const MAX_FULL_SOURCE_DEPS = 10;
  // A dep/caller inside a primary's span is downgraded to signature-only rather
  // than dropped: the pointer is still worth having, the duplicated body is not.
  // Same for prose: a markdown document that mentions the symbol is a wikilink
  // edge, not code that can break, and inlining the whole document was 32% of
  // the worst prompt in the PR benchmark (got#2379). It stays in the list.
  // Containment is checked against everything the bundle emits, not just the
  // primaries: a class and its own method both landing in `callers` shipped the
  // method's body twice as well.
  const emitted = [...primarySymbols, ...depSymbols, ...callerSymbols];
  const signatureOnly = (
    e: { sym: SymbolRow; file: FileRow },
    i: number,
    unionOffset: number,
  ): boolean =>
    i >= MAX_FULL_SOURCE_DEPS ||
    e.file.language === 'markdown' ||
    isWholeFile(e.sym, e.file) ||
    isContainedInAnother(emitted, unionOffset + i);
  const depSignatureOnly = depSymbols.map((d, i) => signatureOnly(d, i, primarySymbols.length));
  const callerSignatureOnly = callerSymbols.map((c, i) =>
    signatureOnly(c, i, primarySymbols.length + depSymbols.length),
  );
  const depItems: ContextItem[] = depSymbols.map((d, i) =>
    toContextItemCached(d.sym, d.file, fileCache, 0.8 - i * 0.005, depSignatureOnly[i]),
  );
  const callerItems: ContextItem[] = callerSymbols.map((c, i) =>
    toContextItemCached(c.sym, c.file, fileCache, 0.6 - i * 0.005, callerSignatureOnly[i]),
  );

  const assembled = assembleStructuredContext({
    primary: primaryItems,
    dependencies: depItems,
    callers: callerItems,
    typeContext: [],
    totalBudget: budget,
  });

  const result: ContextBundleResult = {
    // A primary dropped as contained still ships its bytes — inside the
    // enclosing primary that replaced it — so it reports source_included.
    primary: primarySymbols.map((p) => toBundleItem(p.sym, p.file, true)),
    dependencies: depSymbols
      .slice(0, assembled.dependencies.length)
      .map((d, i) => toBundleItem(d.sym, d.file, !depSignatureOnly[i])),
    callers: callerSymbols
      .slice(0, assembled.callers.length)
      .map((c, i) => toBundleItem(c.sym, c.file, !callerSignatureOnly[i])),
    totalTokens: assembled.totalTokens,
    truncated: assembled.truncated,
  };

  if (opts.outputFormat === 'markdown') {
    result.content = renderStructuredContext(assembled);
  }

  return ok(result);
}
