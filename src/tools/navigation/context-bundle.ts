/**
 * get_context_bundle — symbol source + import dependencies + optional callers,
 * packed within a token budget. Deduplicates shared imports for batch queries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { err, ok } from 'neverthrow';
import type { FileRow, Store, SymbolRow } from '../../db/store.js';
import type { TraceMcpResult } from '../../errors.js';
import type { AssembledItem, ContextItem, DetailLevel } from '../../scoring/assembly.js';
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
   * Whether the assembled context actually carries this symbol's body
   * ('full'), a signature-only fallback, or neither. TRA-1100: before this
   * field existed, a consumer could only tell that a symbol was *listed*,
   * not whether its body survived assembly — which is exactly how the
   * TRA-1090 bare-`require` regression measured 100% "readable" on bundles
   * that carried no source at all.
   *
   * Measured cost (o200k, code review 2026-09-07): +4 tokens per item for
   * 'full', +5 for 'no_source' or 'signature_only' — negligible next to the
   * body text this field describes.
   */
  detail: DetailLevel;
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
function containerIndexOf(entries: Array<{ sym: SymbolRow }>, i: number): number {
  const e = entries[i].sym;
  if (e.byte_start == null || e.byte_end == null) return -1;
  // The *tightest* container, not the first one found: with class ⊇ method ⊇
  // helper all requested, naming the class as the helper's container would hide
  // the method from the chain, and the restore pass below would put helper and
  // method back in the same round — shipping the helper twice.
  let best = -1;
  let bestSpan = Number.POSITIVE_INFINITY;
  entries.forEach(({ sym: o }, j) => {
    if (j === i || o.file_id !== e.file_id) return;
    if (o.byte_start == null || o.byte_end == null) return;
    if (o.byte_start > e.byte_start || o.byte_end < e.byte_end) return;
    const sameSpan = o.byte_start === e.byte_start && o.byte_end === e.byte_end;
    if (sameSpan && j > i) return;
    const span = o.byte_end - o.byte_start;
    if (span < bestSpan) {
      best = j;
      bestSpan = span;
    }
  });
  return best;
}

function isContainedInAnother(entries: Array<{ sym: SymbolRow }>, i: number): boolean {
  return containerIndexOf(entries, i) >= 0;
}

/**
 * The mirror of the rule above, for the direction it does not cover: a class
 * that surfaces as a *dependency* of its own method, while that method is the
 * primary, contains the primary rather than being contained by it — so nothing
 * above catches it and both bodies ship. Found in review of this change.
 *
 * The primary wins, always: it is what the caller asked for and it is assembled
 * at the highest priority, so downgrading it on the strength of a lower-priority
 * entry that the budget may yet truncate would risk losing it outright.
 */
function containsAny(sym: SymbolRow, others: Array<{ sym: SymbolRow }>): boolean {
  if (sym.byte_start == null || sym.byte_end == null) return false;
  return others.some(({ sym: o }) => {
    if (o.file_id !== sym.file_id || o.symbol_id === sym.symbol_id) return false;
    if (o.byte_start == null || o.byte_end == null) return false;
    return sym.byte_start <= o.byte_start && sym.byte_end >= o.byte_end;
  });
}

/**
 * A `__module__:foo` namespace spans its whole file. As a *primary* that is
 * what the caller asked for, but as a dependency or a caller it means "this
 * file mentions your symbol somewhere" — and inlining a whole test file to say
 * so cost more than the review's entire baseline (axios#11039). It stays listed.
 *
 * Spanning the file is not enough on its own: a one-function file's function
 * spans it too, and its body is exactly what the caller wants. What marks a
 * wrapper is that the indexer synthesised it to stand for the file, which the
 * four plugins that create one all record as `metadata.synthetic`
 * (TypeScript/Vue/Astro's `__module__:x`, Python's `x.<module>`). Markdown
 * documents are wrappers too but never reach here — the language check above
 * has already caught them.
 *
 * Suggested in review, replacing a match on those symbols' names: the flag is
 * already in the row, and no real symbol can collide with it.
 */
function isWholeFileContainer(sym: SymbolRow, file: FileRow): boolean {
  if (sym.byte_start == null || sym.byte_end == null || file.byte_length == null) return false;
  if (sym.byte_start !== 0 || sym.byte_end < file.byte_length) return false;
  try {
    return (JSON.parse(sym.metadata ?? '{}') as { synthetic?: boolean }).synthetic === true;
  } catch {
    return false;
  }
}

function toBundleItem(sym: SymbolRow, file: FileRow, detail: DetailLevel): BundleSymbolItem {
  return {
    symbol_id: sym.symbol_id,
    name: sym.name,
    kind: sym.kind,
    file: file.path,
    line: sym.line_start,
    detail,
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
  const primaryContainer = primarySymbols.map((_, i) => containerIndexOf(primarySymbols, i));
  /** Outermost primary carrying entry `i`'s bytes — containers can nest. */
  const outermostContainer = (i: number): number => {
    let at = i;
    for (let hops = 0; primaryContainer[at] >= 0 && hops <= primarySymbols.length; hops++) {
      at = primaryContainer[at];
    }
    return at;
  };
  const buildPrimaryItems = (dropped: Set<number>): ContextItem[] =>
    primarySymbols
      .map((p, i) =>
        dropped.has(i)
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
    isWholeFileContainer(e.sym, e.file) ||
    isContainedInAnother(emitted, unionOffset + i) ||
    containsAny(e.sym, primarySymbols);
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

  let dropped = new Set(primarySymbols.map((_, i) => i).filter((i) => primaryContainer[i] >= 0));
  let assembled = assembleStructuredContext({
    primary: buildPrimaryItems(dropped),
    dependencies: depItems,
    callers: callerItems,
    typeContext: [],
    totalBudget: budget,
  });

  // Dropping a member in favour of its container is only free while the
  // container's body actually survives assembly. When the budget reduces the
  // container to a signature, the member is the one thing that could still have
  // fitted — so it goes back in and the bundle is assembled again. Without
  // this, deduplication costs changed-symbol coverage on exactly the PRs where
  // a small changed function lives in a file too large to ship whole.
  //
  // One level at a time, outermost first: restoring a whole chain at once would
  // put a member back alongside an ancestor that then ships in full, which is
  // the duplication this change exists to remove. Found in review.
  const shipped = (items: AssembledItem[]): Set<string> =>
    new Set(items.filter((item) => item.detail === 'full').map((item) => item.id));
  const ancestorsOf = (i: number): number[] => {
    const chain: number[] = [];
    let at = i;
    while (primaryContainer[at] >= 0 && chain.length <= primarySymbols.length) {
      at = primaryContainer[at];
      chain.push(at);
    }
    return chain;
  };
  for (let pass = 0; pass < primarySymbols.length; pass++) {
    const full = shipped(assembled.primary);
    const uncovered = [...dropped].filter(
      (i) =>
        !ancestorsOf(i).some((a) => !dropped.has(a) && full.has(primarySymbols[a].sym.symbol_id)),
    );
    if (uncovered.length === 0) break;
    const stillDropped = new Set(uncovered);
    const outermostUncovered = uncovered.filter(
      (i) => !ancestorsOf(i).some((a) => stillDropped.has(a)),
    );
    if (outermostUncovered.length === 0) break;
    dropped = new Set([...dropped].filter((i) => !outermostUncovered.includes(i)));
    assembled = assembleStructuredContext({
      primary: buildPrimaryItems(dropped),
      dependencies: depItems,
      callers: callerItems,
      typeContext: [],
      totalBudget: budget,
    });
  }

  // Assembly can drop an item entirely under budget pressure (tryAssemble
  // returns null when even signature_only doesn't fit). The returned groups
  // must reflect exactly what assembly produced — a count-based slice of the
  // pre-assembly list silently disagrees with `content` whenever a middle
  // item is dropped while a later one survives.
  const primaryById = new Map(primarySymbols.map((p) => [p.sym.symbol_id, p] as const));
  const depById = new Map(depSymbols.map((d) => [d.sym.symbol_id, d] as const));
  const callerById = new Map(callerSymbols.map((c) => [c.sym.symbol_id, c] as const));

  const fromAssembled = (
    items: AssembledItem[],
    byId: Map<string, { sym: SymbolRow; file: FileRow }>,
  ): BundleSymbolItem[] => {
    const out: BundleSymbolItem[] = [];
    for (const item of items) {
      const entry = byId.get(item.id);
      if (entry) out.push(toBundleItem(entry.sym, entry.file, item.detail));
    }
    return out;
  };

  // A primary dropped as contained (TRA-1141) is not in `assembled.primary` at
  // all, but its bytes did ship — inside the container that replaced it. It is
  // reported with that container's detail, so a consumer counting delivered
  // bodies neither loses it nor over-claims it when the container was itself
  // reduced to a signature. Containers nest, so walk up to the emitted one.
  const primaryDetailById = new Map(assembled.primary.map((item) => [item.id, item.detail]));
  const containedPrimaries: BundleSymbolItem[] = [];
  primarySymbols.forEach((p, i) => {
    if (!dropped.has(i)) return;
    const detail = primaryDetailById.get(primarySymbols[outermostContainer(i)].sym.symbol_id);
    if (detail) containedPrimaries.push(toBundleItem(p.sym, p.file, detail));
  });

  const result: ContextBundleResult = {
    primary: [...fromAssembled(assembled.primary, primaryById), ...containedPrimaries],
    dependencies: fromAssembled(assembled.dependencies, depById),
    callers: fromAssembled(assembled.callers, callerById),
    totalTokens: assembled.totalTokens,
    truncated: assembled.truncated,
  };

  if (opts.outputFormat === 'markdown') {
    result.content = renderStructuredContext(assembled);
  }

  return ok(result);
}
