/**
 * Structured negative evidence — enriches zero-result responses
 * so the AI client knows the search was exhaustive and should not retry.
 */

interface SearchEvidence {
  scope: 'full_index';
  indexed_files: number;
  indexed_symbols: number;
  query_expanded: boolean;
  verdict: 'not_found_in_project';
  suggestion: string;
}

const TOOL_SUGGESTIONS: Record<string, string> = {
  find_usages: 'This symbol has no incoming references in the dependency graph. It may be dead code or only used dynamically.',
  get_tests_for: 'No tests found for this symbol/file. Consider creating tests or check if tests use a different naming convention.',
  search_text: 'No text matches found in the indexed files. Check spelling or try a broader pattern.',
};

const DEFAULT_SUGGESTION = 'This pattern does not exist in the indexed codebase. Do not search again with similar terms.';

/**
 * Build a negative-evidence block for zero-result search responses.
 * @param indexedFiles  Total files in the index
 * @param indexedSymbols Total symbols in the index
 * @param queryExpanded Whether fuzzy/AI fallback was attempted
 * @param toolName The tool that produced zero results
 */
export function buildNegativeEvidence(
  indexedFiles: number,
  indexedSymbols: number,
  queryExpanded: boolean,
  toolName: string,
): SearchEvidence {
  return {
    scope: 'full_index',
    indexed_files: indexedFiles,
    indexed_symbols: indexedSymbols,
    query_expanded: queryExpanded,
    verdict: 'not_found_in_project',
    suggestion: TOOL_SUGGESTIONS[toolName] ?? DEFAULT_SUGGESTION,
  };
}
