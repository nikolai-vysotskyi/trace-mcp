/**
 * LRU cache for `search()` results.
 *
 * Avoids re-running BM25 / hybrid_ai + PageRank scoring + symbol/file
 * batch fetches when an agent issues the same query twice in one session
 * (e.g. via plan_turn → search → search-text fallback chains).
 *
 * Keyed by a deterministic JSON of (query, filters, limit, offset, mode).
 * Bounded at 128 entries with LRU eviction. Invalidated:
 *  - automatically by `register_edit` and `reindex` (via invalidateSearchCache())
 *  - automatically when the indexed-symbol count changes between calls (cheap
 *    sanity check that catches background indexing finishing mid-session).
 */
import type { FileRow, SymbolRow } from '../db/store.js';

export interface CachedSearchItem {
  symbol: SymbolRow;
  file: FileRow;
  score: number;
}

export interface CachedSearchResult {
  items: CachedSearchItem[];
  total: number;
  search_mode?: 'hybrid_ai' | 'fts' | 'fuzzy' | 'fusion';
}

const MAX_ENTRIES = 128;

interface CacheEntry {
  key: string;
  value: CachedSearchResult;
  /** Symbol count at the time of insertion — used as a coarse staleness signal */
  symbolCount: number;
}

/**
 * Tiny LRU. Map insertion order = recency; on hit we delete + reinsert to bump.
 */
const _cache = new Map<string, CacheEntry>();
let _hits = 0;
let _misses = 0;
let _evictions = 0;

export function invalidateSearchCache(): void {
  _cache.clear();
}

export function getSearchCacheStats(): {
  size: number;
  max: number;
  hits: number;
  misses: number;
  evictions: number;
} {
  return {
    size: _cache.size,
    max: MAX_ENTRIES,
    hits: _hits,
    misses: _misses,
    evictions: _evictions,
  };
}

/** Reset all counters and clear the cache. Test-only helper. */
export function resetSearchCache(): void {
  _cache.clear();
  _hits = 0;
  _misses = 0;
  _evictions = 0;
}

export function buildSearchCacheKey(parts: {
  query: string;
  filters?: Record<string, unknown>;
  limit: number;
  offset: number;
  mode: string;
}): string {
  // Stable JSON: sort filter keys so {a:1,b:2} == {b:2,a:1}
  const sortedFilters: Record<string, unknown> = {};
  if (parts.filters) {
    for (const k of Object.keys(parts.filters).sort()) {
      const v = parts.filters[k];
      if (v !== undefined && v !== null) sortedFilters[k] = v;
    }
  }
  return JSON.stringify({
    q: parts.query,
    f: sortedFilters,
    l: parts.limit,
    o: parts.offset,
    m: parts.mode,
  });
}

export function getCachedSearch(
  key: string,
  currentSymbolCount: number,
): CachedSearchResult | null {
  const entry = _cache.get(key);
  if (!entry) {
    _misses++;
    return null;
  }
  // Staleness check: if the index grew/shrunk, drop the entry
  if (entry.symbolCount !== currentSymbolCount) {
    _cache.delete(key);
    _misses++;
    return null;
  }
  // LRU bump: re-insert at the tail
  _cache.delete(key);
  _cache.set(key, entry);
  _hits++;
  return entry.value;
}

export function putCachedSearch(
  key: string,
  value: CachedSearchResult,
  currentSymbolCount: number,
): void {
  // Don't cache empty results — they're cheap to recompute and the negative
  // evidence shape changes if the index grows. Also avoids polluting the LRU
  // with bad-query churn.
  if (value.items.length === 0) return;

  if (_cache.has(key)) {
    _cache.delete(key);
  } else if (_cache.size >= MAX_ENTRIES) {
    // Evict oldest (Map iteration order = insertion order)
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) {
      _cache.delete(oldest);
      _evictions++;
    }
  }
  _cache.set(key, { key, value, symbolCount: currentSymbolCount });
}
