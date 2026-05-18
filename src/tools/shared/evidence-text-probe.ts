/**
 * Helper for resolver-gap detection: count textual occurrences of a bare
 * symbol name in indexed files. Used by zero-result paths to decide
 * whether to upgrade verdict `indexed_no_edges` → `resolver_gap_suspected`.
 *
 * Kept in its own module so `evidence.ts` stays decoupled from Store /
 * filesystem concerns (it's the pure verdict-shaping module).
 */

import type { Store } from '../../db/store.js';
import { searchText } from '../navigation/search-text.js';
import { extractBareName } from './evidence.js';

/**
 * Count textual occurrences of `bareName` across .ts / .js / .py files.
 * Caps the search at `cap` matches (default 8 — enough to clear the
 * "occ > 2" threshold without scanning the whole repo on hot names).
 * Returns 0 on failure (gap detection then silently skips).
 */
export function countNameOccurrences(
  store: Store,
  projectRoot: string,
  bareName: string,
  cap = 8,
): number {
  if (!bareName) return 0;
  // Word-boundary regex so "compute" doesn't match "recomputed".
  const pattern = `\\b${escapeRegex(bareName)}\\b`;
  const result = searchText(store, projectRoot, {
    query: pattern,
    isRegex: true,
    filePattern: '**/*.{ts,tsx,js,jsx,mjs,cjs,py}',
    maxResults: cap,
    caseSensitive: true,
    contextLines: 0,
    timeoutMs: 800,
  });
  if (result.isErr()) return 0;
  return result.value.total_matches;
}

/**
 * Convenience: derive bare name from a symbol_id/FQN and count occurrences
 * in one call. Returns `{ bareName: null, occurrences: 0 }` when no bare
 * name can be extracted (caller can short-circuit gap detection).
 */
export function probeSymbolName(
  store: Store,
  projectRoot: string,
  symbolOrFqn: string | undefined,
): { bareName: string | null; occurrences: number } {
  if (!symbolOrFqn) return { bareName: null, occurrences: 0 };
  const bare = extractBareName(symbolOrFqn);
  if (!bare) return { bareName: null, occurrences: 0 };
  return { bareName: bare, occurrences: countNameOccurrences(store, projectRoot, bare) };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
