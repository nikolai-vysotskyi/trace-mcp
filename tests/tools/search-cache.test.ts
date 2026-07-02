/**
 * Tests for the LRU search cache + its integration with `search()`.
 *
 * Coverage:
 *  - Same query twice → cache hit (verified via getSearchCacheStats)
 *  - Different query → miss
 *  - Empty results not cached (negative-evidence shape stays fresh)
 *  - Index growth invalidates per-entry staleness check
 *  - Eviction: bounded to MAX_ENTRIES (128)
 *  - LRU bump: hitting an entry moves it to most-recent
 *  - Pipeline reindex / register_edit invalidate the cache wholesale
 */

import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import {
  buildSearchCacheKey,
  getCachedSearch,
  getSearchCacheStats,
  invalidateSearchCache,
  putCachedSearch,
  resetSearchCache,
} from '../../src/scoring/search-cache.js';
import { search } from '../../src/tools/navigation/navigation.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/laravel-10');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['app/**/*.php', 'routes/**/*.php', 'database/migrations/**/*.php'],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

// ═══════════════════════════════════════════════════════════════════
// Pure unit tests (no Store needed)
// ═══════════════════════════════════════════════════════════════════

// A plain object is a valid WeakMap key. Using the SAME object for every call
// in these unit tests preserves the exact single-DB LRU / staleness / hit
// behavior the assertions below rely on.
const DB = {} as unknown as import('better-sqlite3').Database;

describe('search-cache (pure)', () => {
  beforeEach(() => resetSearchCache());

  it('buildSearchCacheKey is order-independent for filters', () => {
    const a = buildSearchCacheKey({
      query: 'foo',
      filters: { kind: 'class', language: 'ts' },
      limit: 10,
      offset: 0,
      mode: 'fts',
    });
    const b = buildSearchCacheKey({
      query: 'foo',
      filters: { language: 'ts', kind: 'class' },
      limit: 10,
      offset: 0,
      mode: 'fts',
    });
    expect(a).toBe(b);
  });

  it('buildSearchCacheKey distinguishes different limits', () => {
    const a = buildSearchCacheKey({ query: 'foo', limit: 10, offset: 0, mode: 'fts' });
    const b = buildSearchCacheKey({ query: 'foo', limit: 20, offset: 0, mode: 'fts' });
    expect(a).not.toBe(b);
  });

  it('put + get roundtrips a non-empty result', () => {
    const key = 'k1';
    const value = {
      items: [{ symbol: {} as any, file: {} as any, score: 1 }],
      total: 1,
      search_mode: 'fts' as const,
    };
    putCachedSearch(DB, key, value, 100);
    const got = getCachedSearch(DB, key, 100);
    expect(got).not.toBeNull();
    expect(got!.total).toBe(1);
    expect(getSearchCacheStats(DB).hits).toBe(1);
  });

  it('does not cache empty results', () => {
    putCachedSearch(DB, 'k-empty', { items: [], total: 0, search_mode: 'fts' }, 100);
    expect(getSearchCacheStats(DB).size).toBe(0);
  });

  it('staleness: symbol count change invalidates entry', () => {
    const key = 'k-stale';
    putCachedSearch(
      DB,
      key,
      { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
      100,
    );
    expect(getCachedSearch(DB, key, 101)).toBeNull(); // stale → miss
    expect(getCachedSearch(DB, key, 100)).toBeNull(); // and now also gone
  });

  it('LRU eviction: oldest entry is dropped when over MAX', () => {
    // MAX = 128. Insert 130 to force 2 evictions.
    for (let i = 0; i < 130; i++) {
      putCachedSearch(
        DB,
        `k-${i}`,
        { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
        100,
      );
    }
    const stats = getSearchCacheStats(DB);
    expect(stats.size).toBe(128);
    expect(stats.evictions).toBe(2);
    // The first two should be gone
    expect(getCachedSearch(DB, 'k-0', 100)).toBeNull();
    expect(getCachedSearch(DB, 'k-1', 100)).toBeNull();
    // The last should still be there
    expect(getCachedSearch(DB, 'k-129', 100)).not.toBeNull();
  });

  it('LRU bump: hit moves entry to most-recent', () => {
    putCachedSearch(
      DB,
      'a',
      { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
      100,
    );
    putCachedSearch(
      DB,
      'b',
      { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
      100,
    );
    // Touch 'a' so it becomes most-recent
    getCachedSearch(DB, 'a', 100);
    // Fill remaining slots
    for (let i = 0; i < 127; i++) {
      putCachedSearch(
        DB,
        `k-${i}`,
        { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
        100,
      );
    }
    // 'b' should have been evicted (oldest), 'a' should still be present
    expect(getCachedSearch(DB, 'b', 100)).toBeNull();
    expect(getCachedSearch(DB, 'a', 100)).not.toBeNull();
  });

  it('invalidateSearchCache clears all entries', () => {
    putCachedSearch(
      DB,
      'a',
      { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
      100,
    );
    expect(getSearchCacheStats(DB).size).toBe(1);
    invalidateSearchCache(); // global clear (no db) resets the whole WeakMap
    expect(getSearchCacheStats(DB).size).toBe(0);
  });

  it('invalidateSearchCache(db) clears only that DB, leaving others intact', () => {
    const DB_A = {} as unknown as import('better-sqlite3').Database;
    const DB_B = {} as unknown as import('better-sqlite3').Database;
    const entry = { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 };
    putCachedSearch(DB_A, 'k', entry, 100);
    putCachedSearch(DB_B, 'k', entry, 100);
    invalidateSearchCache(DB_A);
    expect(getSearchCacheStats(DB_A).size).toBe(0);
    expect(getSearchCacheStats(DB_B).size).toBe(1);
    expect(getCachedSearch(DB_B, 'k', 100)).not.toBeNull();
  });

  it('cross-DB isolation: entry stored under one DB is invisible under another', () => {
    const DB_A = {} as unknown as import('better-sqlite3').Database;
    const DB_B = {} as unknown as import('better-sqlite3').Database;
    // Same key + same symbolCount + same query params under two distinct DB
    // objects (models :memory: collision across parallel tests / daemon
    // projects). Before the per-DB WeakMap fix these collided.
    putCachedSearch(
      DB_A,
      'shared-key',
      { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
      100,
    );
    expect(getCachedSearch(DB_B, 'shared-key', 100)).toBeNull(); // miss under DB_B
    expect(getCachedSearch(DB_A, 'shared-key', 100)).not.toBeNull(); // hit under DB_A
  });
});

// ═══════════════════════════════════════════════════════════════════
// Integration tests with actual search() + indexed Store
// ═══════════════════════════════════════════════════════════════════

describe('search-cache (integration)', () => {
  let store: Store;
  let registry: PluginRegistry;

  beforeAll(async () => {
    store = createTestStore();
    registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE_DIR);
    await pipeline.indexAll();
  });

  beforeEach(() => resetSearchCache());

  it('second identical search() hits the cache', async () => {
    const before = getSearchCacheStats(store.db);
    await search(store, 'UserController');
    const afterFirst = getSearchCacheStats(store.db);
    expect(afterFirst.misses).toBe(before.misses + 1);

    await search(store, 'UserController');
    const afterSecond = getSearchCacheStats(store.db);
    expect(afterSecond.hits).toBe(afterFirst.hits + 1);
  });

  it('different queries do not collide', async () => {
    await search(store, 'UserController');
    await search(store, 'DashboardController');
    const stats = getSearchCacheStats(store.db);
    expect(stats.size).toBeGreaterThanOrEqual(2);
  });

  it('different limits cache separately', async () => {
    await search(store, 'UserController', undefined, 5);
    await search(store, 'UserController', undefined, 10);
    const stats = getSearchCacheStats(store.db);
    expect(stats.size).toBeGreaterThanOrEqual(2);
  });

  it('zero-result query is not cached (stays fresh for negative evidence)', async () => {
    await search(store, 'xyzzyplugh99nonexistent');
    const stats = getSearchCacheStats(store.db);
    expect(stats.size).toBe(0);
  });

  it('reindex via pipeline invalidates the cache', async () => {
    await search(store, 'UserController');
    expect(getSearchCacheStats(store.db).size).toBeGreaterThan(0);
    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE_DIR);
    await pipeline.indexAll();
    expect(getSearchCacheStats(store.db).size).toBe(0);
  });
});
