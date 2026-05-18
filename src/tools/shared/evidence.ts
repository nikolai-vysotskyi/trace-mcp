/**
 * Structured negative evidence — enriches zero-result responses
 * so the AI client knows the search/relation lookup was exhaustive
 * and should not retry with similar terms.
 *
 * Verdict taxonomy (post-split):
 *  - `not_found`                  — symbol/query is genuinely not in the index
 *  - `indexed_no_edges`           — symbol IS in the index but has zero edges of
 *                                   the requested kind, AND nothing suggests the
 *                                   resolver missed something. Likely truly dead.
 *  - `resolver_gap_suspected`     — symbol IS in the index, edges are empty for
 *                                   the requested kind, BUT textual occurrences
 *                                   of the bare name in the codebase suggest the
 *                                   resolver missed parametric / dynamic call
 *                                   sites. Confirm with search_text.
 *
 * Backwards-compat aliases (still accepted, mapped onto the new taxonomy):
 *  - `not_found_in_project`        ≡ `not_found`
 *  - `symbol_indexed_but_isolated` ≡ `indexed_no_edges`
 */

export type EvidenceVerdict =
  | 'not_found'
  | 'indexed_no_edges'
  | 'resolver_gap_suspected'
  // Legacy aliases — kept so callers that still pass these strings keep working.
  | 'not_found_in_project'
  | 'symbol_indexed_but_isolated';

export interface SearchEvidence {
  scope: 'full_index';
  indexed_files: number;
  indexed_symbols: number;
  query_expanded: boolean;
  verdict: EvidenceVerdict;
  suggestion: string;
  /** Optional anchor: which symbol was looked up (for isolation evidence) */
  symbol?: string;
  /**
   * When verdict === 'resolver_gap_suspected', the number of textual
   * occurrences of the bare symbol name across indexed files.
   */
  text_occurrences?: number;
}

/**
 * Names that appear so often in everyday code that text-occurrence count is
 * meaningless. Mostly JS/TS array+map+set+promise APIs and a few Python builtins.
 */
const COMMON_NAMES = new Set<string>([
  // array / collection
  'push',
  'pop',
  'shift',
  'unshift',
  'slice',
  'splice',
  'concat',
  'join',
  'map',
  'filter',
  'reduce',
  'forEach',
  'find',
  'some',
  'every',
  'includes',
  'indexOf',
  'sort',
  // map / set / object
  'get',
  'set',
  'has',
  'delete',
  'clear',
  'add',
  'size',
  'keys',
  'values',
  'entries',
  // promise / async
  'then',
  'catch',
  'finally',
  'resolve',
  'reject',
  'all',
  'race',
  'allSettled',
  // misc / lifecycle / common verbs
  'init',
  'start',
  'stop',
  'run',
  'next',
  'prev',
  'open',
  'close',
  'read',
  'write',
  'send',
  'receive',
  'load',
  'save',
  'create',
  'update',
  'destroy',
  'render',
  'mount',
  'unmount',
  'on',
  'off',
  'emit',
  'toString',
  'valueOf',
  // Python builtins / common
  'len',
  'str',
  'int',
  'list',
  'dict',
  'tuple',
  'append',
  'extend',
  'remove',
  'print',
  'range',
  'iter',
  '__init__',
  '__str__',
  '__repr__',
]);

/**
 * Strip a method's class/namespace prefix and pull out the bare identifier.
 * Examples:
 *   "src/db/store.ts::Store#class::getSymbolById#method"  -> "getSymbolById"
 *   "Store#class::getSymbolById#method"                   -> "getSymbolById"
 *   "myFunction"                                          -> "myFunction"
 *   "Foo.bar.baz"                                         -> "baz"
 */
export function extractBareName(symbolOrFqn: string): string | null {
  if (!symbolOrFqn) return null;
  // Take the last segment after :: (FQN style)
  let s = symbolOrFqn;
  const ccIdx = s.lastIndexOf('::');
  if (ccIdx >= 0) s = s.slice(ccIdx + 2);
  // Strip kind suffix (#method / #function / #class)
  const hashIdx = s.indexOf('#');
  if (hashIdx >= 0) s = s.slice(0, hashIdx);
  // Strip namespace dots / slashes / parens — keep last identifier piece
  const dotIdx = s.lastIndexOf('.');
  if (dotIdx >= 0) s = s.slice(dotIdx + 1);
  const slashIdx = s.lastIndexOf('/');
  if (slashIdx >= 0) s = s.slice(slashIdx + 1);
  s = s.replace(/[()<>[\]]/g, '').trim();
  if (!s) return null;
  // Sanity: must look like an identifier
  if (!/^[A-Za-z_$][\w$]*$/.test(s)) return null;
  return s;
}

/**
 * Decide whether an empty-edges result for `symbol` should be classified as
 * `resolver_gap_suspected` rather than `indexed_no_edges`.
 *
 * Heuristic (per spec):
 *   - Extract the bare name from the symbol/FQN.
 *   - Skip common JS/Python builtins (push/pop/get/set/has/...).
 *   - If `kindHint` is 'interface' or 'type', NEVER classify as gap — these
 *     legitimately lack runtime edges.
 *   - If a text-occurrence count of the bare name is > 2, classify as gap.
 *
 * The caller supplies `textOccurrences` (typically from search_text) so this
 * module stays decoupled from the Store / filesystem.
 */
export interface GapClassification {
  isGap: boolean;
  bareName: string | null;
  textOccurrences: number;
}

export function classifyResolverGap(opts: {
  symbol?: string;
  kindHint?: string;
  textOccurrences: number;
}): GapClassification {
  const bare = opts.symbol ? extractBareName(opts.symbol) : null;
  const occ = Math.max(0, opts.textOccurrences | 0);

  // Interfaces / type aliases legitimately have no runtime edges.
  const kind = (opts.kindHint ?? '').toLowerCase();
  if (kind === 'interface' || kind === 'type' || kind === 'type_alias') {
    return { isGap: false, bareName: bare, textOccurrences: occ };
  }

  if (!bare) return { isGap: false, bareName: null, textOccurrences: occ };
  if (COMMON_NAMES.has(bare)) {
    return { isGap: false, bareName: bare, textOccurrences: occ };
  }
  return { isGap: occ > 2, bareName: bare, textOccurrences: occ };
}

type NormalizedVerdict = 'not_found' | 'indexed_no_edges' | 'resolver_gap_suspected';

function normalizeVerdict(v: EvidenceVerdict): NormalizedVerdict {
  if (v === 'not_found_in_project') return 'not_found';
  if (v === 'symbol_indexed_but_isolated') return 'indexed_no_edges';
  return v;
}

// ─── Per-verdict default suggestions (used when no tool-specific
//     override applies). Keeps the suggestion text aligned with what the
//     agent should actually do next.
const DEFAULT_SUGGESTIONS_BY_VERDICT: Record<NormalizedVerdict, string> = {
  not_found:
    'Symbol not in indexed codebase. Verify spelling or check if the file is in include patterns.',
  indexed_no_edges:
    'Symbol indexed with zero edges of this kind. May be dead code OR may use dynamic dispatch the resolver cannot trace. Consider search_text as a sanity check.',
  resolver_gap_suspected:
    'Symbol indexed but edges incomplete. search_text finds occurrences of this name — the resolver likely missed parametric / dynamic call sites. Confirm with search_text or grep.',
};

/**
 * Tool-specific suggestion overrides. These pre-date the verdict split, so
 * they're keyed by toolName for backwards compatibility. The default
 * per-verdict messages above kick in for tools not in this map.
 *
 * NOTE: for resolver_gap_suspected we deliberately do NOT consult this map —
 * the gap-specific suggestion (with text_occurrences) is more actionable than
 * the generic per-tool text.
 */
const TOOL_SUGGESTIONS: Record<string, string> = {
  // ─── search-style tools (verdict: not_found) ─────────────────
  search:
    'No symbols matched this query. Do not retry with similar terms. Try fuzzy=true or use search_text for raw content matching.',
  search_text:
    'No text matches found in the indexed files. Check spelling or try a broader pattern.',
  get_feature_context:
    'No code matched this feature description. Try more specific technical terms or symbol names.',
  query_by_intent:
    'No symbols matched this intent query. Rephrase with concrete terms (function names, class names, patterns).',

  // ─── audit tools — empty result is GOOD news ─────────────────
  get_dead_code:
    'No dead code detected — all symbols have incoming references or are entry points.',
  get_dead_exports: 'No dead exports found — every exported symbol is imported somewhere.',
  get_untested_exports:
    'No untested public exports — every exported symbol has matching test coverage.',
  get_untested_symbols: 'No untested symbols found — every function and class has test coverage.',
  get_circular_imports: 'No circular import chains found in the analyzed scope.',

  // ─── relation tools (verdict: indexed_no_edges) ──────────────
  find_usages:
    'Zero references in the dependency graph. This may mean the symbol is dead, OR that callers use it through a parametric type / dynamic dispatch the resolver did not link. Confirm with `search_text { query: "<symbol_name>" }` (or Bash grep) before treating it as dead.',
  get_tests_for:
    'No tests found for this symbol/file. Consider creating tests or check if tests use a different naming convention.',
  get_call_graph:
    'This symbol is a leaf in the call graph: no callers and no callees were resolved. Either it is dead code, only invoked dynamically, or its call edges were not extracted (check the language plugin).',
  get_type_hierarchy:
    'This name has no parents (extends/implements) and no descendants in the indexed codebase. Either it is a standalone class/interface, or the name does not match any indexed type.',
  get_implementations:
    'No classes implement or extend this name. It may be unused, an external type, or the indexer did not capture the heritage relation.',
};

/**
 * Build a negative-evidence block for zero-result responses.
 *
 * Backwards-compatible signature: positional form for the simple
 * `not_found` case (used by existing search tools), and an
 * options-object overload for richer cases (isolation, symbol anchor,
 * resolver-gap detection).
 */
export function buildNegativeEvidence(
  indexedFiles: number,
  indexedSymbols: number,
  queryExpanded: boolean,
  toolName: string,
): SearchEvidence;
export function buildNegativeEvidence(opts: {
  indexedFiles: number;
  indexedSymbols: number;
  queryExpanded?: boolean;
  toolName: string;
  verdict?: EvidenceVerdict;
  symbol?: string;
  /**
   * Symbol kind hint ('class' | 'interface' | 'function' | 'method' | 'type'),
   * used by gap detection to avoid mis-flagging interfaces.
   */
  symbolKind?: string;
  /**
   * Optional text-occurrence count of the bare symbol name across indexed
   * files. When supplied AND verdict resolves to indexed_no_edges, the
   * verdict may be upgraded to resolver_gap_suspected.
   */
  textOccurrences?: number;
}): SearchEvidence;
export function buildNegativeEvidence(
  filesOrOpts:
    | number
    | {
        indexedFiles: number;
        indexedSymbols: number;
        queryExpanded?: boolean;
        toolName: string;
        verdict?: EvidenceVerdict;
        symbol?: string;
        symbolKind?: string;
        textOccurrences?: number;
      },
  indexedSymbols?: number,
  queryExpanded?: boolean,
  toolName?: string,
): SearchEvidence {
  const opts =
    typeof filesOrOpts === 'object'
      ? filesOrOpts
      : {
          indexedFiles: filesOrOpts,
          indexedSymbols: indexedSymbols!,
          queryExpanded: queryExpanded ?? false,
          toolName: toolName!,
        };

  const requested: EvidenceVerdict = opts.verdict ?? 'not_found';
  let normalized = normalizeVerdict(requested);

  // Gap upgrade: only meaningful when the symbol IS in the index (i.e.
  // the caller already picked indexed_no_edges). Don't upgrade if we
  // were told not_found.
  let gapInfo: GapClassification | null = null;
  if (normalized === 'indexed_no_edges' && typeof opts.textOccurrences === 'number') {
    gapInfo = classifyResolverGap({
      symbol: opts.symbol,
      kindHint: opts.symbolKind,
      textOccurrences: opts.textOccurrences,
    });
    if (gapInfo.isGap) normalized = 'resolver_gap_suspected';
  }

  // Suggestion priority:
  //   1. resolver_gap_suspected → always use the gap-specific message with
  //      the actual occurrence count (most actionable).
  //   2. Tool-specific suggestion override (back-compat with existing text).
  //   3. Default suggestion for the normalized verdict.
  let suggestion: string;
  if (normalized === 'resolver_gap_suspected' && gapInfo) {
    suggestion = `Symbol indexed but edges incomplete. search_text finds ${gapInfo.textOccurrences} occurrences of "${gapInfo.bareName}" — the resolver likely missed parametric / dynamic call sites. Confirm with search_text or grep.`;
  } else {
    suggestion = TOOL_SUGGESTIONS[opts.toolName] ?? DEFAULT_SUGGESTIONS_BY_VERDICT[normalized];
  }

  const ev: SearchEvidence = {
    scope: 'full_index',
    indexed_files: opts.indexedFiles,
    indexed_symbols: opts.indexedSymbols,
    query_expanded: opts.queryExpanded ?? false,
    verdict: normalized,
    suggestion,
  };
  if (opts.symbol) ev.symbol = opts.symbol;
  if (normalized === 'resolver_gap_suspected' && gapInfo) {
    ev.text_occurrences = gapInfo.textOccurrences;
  }
  return ev;
}
