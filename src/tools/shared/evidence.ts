/**
 * Structured negative evidence — enriches zero-result responses
 * so the AI client knows the search/relation lookup was exhaustive
 * and should not retry with similar terms.
 *
 * Two verdicts:
 *  - `not_found_in_project`        — the symbol/query is not in the index at all
 *  - `symbol_indexed_but_isolated` — the symbol exists, but the requested relation
 *                                    (callers, callees, implementors, ancestors,
 *                                    descendants, tests, etc.) is empty
 */

export type EvidenceVerdict = 'not_found_in_project' | 'symbol_indexed_but_isolated';

export interface SearchEvidence {
  scope: 'full_index';
  indexed_files: number;
  indexed_symbols: number;
  query_expanded: boolean;
  verdict: EvidenceVerdict;
  suggestion: string;
  /** Optional anchor: which symbol was looked up (for isolation evidence) */
  symbol?: string;
}

const TOOL_SUGGESTIONS: Record<string, string> = {
  // ─── search-style tools (verdict: not_found_in_project) ─────
  search: 'No symbols matched this query. Do not retry with similar terms. Try fuzzy=true or use search_text for raw content matching.',
  search_text: 'No text matches found in the indexed files. Check spelling or try a broader pattern.',
  get_feature_context: 'No code matched this feature description. Try more specific technical terms or symbol names.',
  query_by_intent: 'No symbols matched this intent query. Rephrase with concrete terms (function names, class names, patterns).',

  // ─── audit tools — empty result is GOOD news ─────────────────
  get_dead_code: 'No dead code detected — all symbols have incoming references or are entry points.',
  get_dead_exports: 'No dead exports found — every exported symbol is imported somewhere.',
  get_untested_exports: 'No untested public exports — every exported symbol has matching test coverage.',
  get_circular_imports: 'No circular import chains found in the analyzed scope.',

  // ─── relation tools (verdict: symbol_indexed_but_isolated) ──
  find_usages: 'This symbol has no incoming references in the dependency graph. It may be dead code or only used dynamically. Do not grep for it as a fallback — the absence is authoritative.',
  get_tests_for: 'No tests found for this symbol/file. Consider creating tests or check if tests use a different naming convention.',
  get_call_graph: 'This symbol is a leaf in the call graph: no callers and no callees were resolved. Either it is dead code, only invoked dynamically, or its call edges were not extracted (check the language plugin).',
  get_type_hierarchy: 'This name has no parents (extends/implements) and no descendants in the indexed codebase. Either it is a standalone class/interface, or the name does not match any indexed type.',
  get_implementations: 'No classes implement or extend this name. It may be unused, an external type, or the indexer did not capture the heritage relation.',
};

const DEFAULT_SUGGESTION_NOT_FOUND =
  'This pattern does not exist in the indexed codebase. Do not search again with similar terms.';

const DEFAULT_SUGGESTION_ISOLATED =
  'The symbol is indexed but the requested relation is empty. The absence is authoritative — do not retry with grep.';

/**
 * Build a negative-evidence block for zero-result responses.
 *
 * Backwards-compatible signature: positional form for the simple
 * `not_found_in_project` case (used by existing search tools), and an
 * options-object overload for richer cases (isolation, symbol anchor).
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
      },
  indexedSymbols?: number,
  queryExpanded?: boolean,
  toolName?: string,
): SearchEvidence {
  const opts = typeof filesOrOpts === 'object'
    ? filesOrOpts
    : {
        indexedFiles: filesOrOpts,
        indexedSymbols: indexedSymbols!,
        queryExpanded: queryExpanded ?? false,
        toolName: toolName!,
      };

  const verdict: EvidenceVerdict = opts.verdict ?? 'not_found_in_project';
  const defaultSuggestion = verdict === 'symbol_indexed_but_isolated'
    ? DEFAULT_SUGGESTION_ISOLATED
    : DEFAULT_SUGGESTION_NOT_FOUND;

  const ev: SearchEvidence = {
    scope: 'full_index',
    indexed_files: opts.indexedFiles,
    indexed_symbols: opts.indexedSymbols,
    query_expanded: opts.queryExpanded ?? false,
    verdict,
    suggestion: TOOL_SUGGESTIONS[opts.toolName] ?? defaultSuggestion,
  };
  if (opts.symbol) ev.symbol = opts.symbol;
  return ev;
}
