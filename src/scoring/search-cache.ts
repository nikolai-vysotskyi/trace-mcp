/**
 * LRU cache for `search()` results.
 *
 * Avoids re-running BM25 / hybrid_ai + PageRank scoring + symbol/file
 * batch fetches when an agent issues the same query twice in one session
 * (e.g. via plan_turn → search → search-text fallback chains).
 *
 * Scoped per Database instance: the outer store is a
 * `WeakMap<Database, Map<string, CacheEntry>>`, and each DB gets its own inner
 * LRU keyed by a deterministic JSON of (query, filters, limit, offset, mode).
 * Keying on the Database object (not `db.name`) is required for correctness —
 * in-memory SQLite databases all report `:memory:`, so a shared string/name
 * key would let distinct DBs (parallel tests, or two daemon projects with the
 * same symbol count + same query) collide and serve one DB's results for
 * another. The WeakMap also auto-releases a project's cache when its DB is GC'd.
 *
 * Each inner map is bounded at 128 entries with LRU eviction. Invalidated:
 *  - automatically by `register_edit` and `reindex` (via invalidateSearchCache(db))
 *  - automatically when the indexed-symbol count changes between calls (cheap
 *    sanity check that catches background indexing finishing mid-session).
 */
import type Database from 'better-sqlite3';
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
 * Per-DB store of tiny LRUs. Each inner Map's insertion order = recency; on hit
 * we delete + reinsert to bump. Keyed on the Database *object* — see file header
 * for why `db.name` would collide across in-memory DBs.
 */
let _perDbCache = new WeakMap<object, Map<string, CacheEntry>>();
let _hits = 0;
let _misses = 0;
let _evictions = 0;

/** Get (lazily creating) the inner LRU map for a given Database instance. */
function getInner(db: Database.Database): Map<string, CacheEntry> {
  let inner = _perDbCache.get(db);
  if (!inner) {
    inner = new Map<string, CacheEntry>();
    _perDbCache.set(db, inner);
  }
  return inner;
}

/**
 * Invalidate the cache. With a `db`, drops only that DB's inner map
 * (per-project invalidation). With no arg, resets the whole WeakMap (global
 * clear) — WeakMap has no clear(), so reassign a fresh instance.
 */
export function invalidateSearchCache(db?: Database.Database): void {
  if (db) {
    _perDbCache.delete(db);
  } else {
    _perDbCache = new WeakMap();
  }
}

export function getSearchCacheStats(db?: Database.Database): {
  size: number;
  max: number;
  hits: number;
  misses: number;
  evictions: number;
} {
  // hits/misses/evictions are module-global aggregate telemetry. `size` is
  // per-DB — a WeakMap is not enumerable, so there is no global sum; report the
  // passed DB's inner map size (0 when no db is given).
  return {
    size: db ? (_perDbCache.get(db)?.size ?? 0) : 0,
    max: MAX_ENTRIES,
    hits: _hits,
    misses: _misses,
    evictions: _evictions,
  };
}

/** Reset all counters and clear every DB's cache. Test-only helper. */
export function resetSearchCache(): void {
  _perDbCache = new WeakMap();
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
  db: Database.Database,
  key: string,
  currentSymbolCount: number,
): CachedSearchResult | null {
  const inner = getInner(db);
  const entry = inner.get(key);
  if (!entry) {
    _misses++;
    return null;
  }
  // Staleness check: if the index grew/shrunk, drop the entry
  if (entry.symbolCount !== currentSymbolCount) {
    inner.delete(key);
    _misses++;
    return null;
  }
  // LRU bump: re-insert at the tail
  inner.delete(key);
  inner.set(key, entry);
  _hits++;
  return entry.value;
}

export function putCachedSearch(
  db: Database.Database,
  key: string,
  value: CachedSearchResult,
  currentSymbolCount: number,
): void {
  // Don't cache empty results — they're cheap to recompute and the negative
  // evidence shape changes if the index grows. Also avoids polluting the LRU
  // with bad-query churn.
  if (value.items.length === 0) return;

  const inner = getInner(db);
  if (inner.has(key)) {
    inner.delete(key);
  } else if (inner.size >= MAX_ENTRIES) {
    // Evict oldest (Map iteration order = insertion order)
    const oldest = inner.keys().next().value;
    if (oldest !== undefined) {
      inner.delete(oldest);
      _evictions++;
    }
  }
  inner.set(key, { key, value, symbolCount: currentSymbolCount });
}
