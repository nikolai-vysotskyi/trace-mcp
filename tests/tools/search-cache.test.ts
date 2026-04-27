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
    putCachedSearch(key, value, 100);
    const got = getCachedSearch(key, 100);
    expect(got).not.toBeNull();
    expect(got!.total).toBe(1);
    expect(getSearchCacheStats().hits).toBe(1);
  });

  it('does not cache empty results', () => {
    putCachedSearch('k-empty', { items: [], total: 0, search_mode: 'fts' }, 100);
    expect(getSearchCacheStats().size).toBe(0);
  });

  it('staleness: symbol count change invalidates entry', () => {
    const key = 'k-stale';
    putCachedSearch(
      key,
      { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
      100,
    );
    expect(getCachedSearch(key, 101)).toBeNull(); // stale → miss
    expect(getCachedSearch(key, 100)).toBeNull(); // and now also gone
  });

  it('LRU eviction: oldest entry is dropped when over MAX', () => {
    // MAX = 128. Insert 130 to force 2 evictions.
    for (let i = 0; i < 130; i++) {
      putCachedSearch(
        `k-${i}`,
        { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
        100,
      );
    }
    const stats = getSearchCacheStats();
    expect(stats.size).toBe(128);
    expect(stats.evictions).toBe(2);
    // The first two should be gone
    expect(getCachedSearch('k-0', 100)).toBeNull();
    expect(getCachedSearch('k-1', 100)).toBeNull();
    // The last should still be there
    expect(getCachedSearch('k-129', 100)).not.toBeNull();
  });

  it('LRU bump: hit moves entry to most-recent', () => {
    putCachedSearch(
      'a',
      { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
      100,
    );
    putCachedSearch(
      'b',
      { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
      100,
    );
    // Touch 'a' so it becomes most-recent
    getCachedSearch('a', 100);
    // Fill remaining slots
    for (let i = 0; i < 127; i++) {
      putCachedSearch(
        `k-${i}`,
        { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
        100,
      );
    }
    // 'b' should have been evicted (oldest), 'a' should still be present
    expect(getCachedSearch('b', 100)).toBeNull();
    expect(getCachedSearch('a', 100)).not.toBeNull();
  });

  it('invalidateSearchCache clears all entries', () => {
    putCachedSearch(
      'a',
      { items: [{ symbol: {} as any, file: {} as any, score: 1 }], total: 1 },
      100,
    );
    expect(getSearchCacheStats().size).toBe(1);
    invalidateSearchCache();
    expect(getSearchCacheStats().size).toBe(0);
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
    const before = getSearchCacheStats();
    await search(store, 'UserController');
    const afterFirst = getSearchCacheStats();
    expect(afterFirst.misses).toBe(before.misses + 1);

    await search(store, 'UserController');
    const afterSecond = getSearchCacheStats();
    expect(afterSecond.hits).toBe(afterFirst.hits + 1);
  });

  it('different queries do not collide', async () => {
    await search(store, 'UserController');
    await search(store, 'DashboardController');
    const stats = getSearchCacheStats();
    expect(stats.size).toBeGreaterThanOrEqual(2);
  });

  it('different limits cache separately', async () => {
    await search(store, 'UserController', undefined, 5);
    await search(store, 'UserController', undefined, 10);
    const stats = getSearchCacheStats();
    expect(stats.size).toBeGreaterThanOrEqual(2);
  });

  it('zero-result query is not cached (stays fresh for negative evidence)', async () => {
    await search(store, 'xyzzyplugh99nonexistent');
    const stats = getSearchCacheStats();
    expect(stats.size).toBe(0);
  });

  it('reindex via pipeline invalidates the cache', async () => {
    await search(store, 'UserController');
    expect(getSearchCacheStats().size).toBeGreaterThan(0);
    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE_DIR);
    await pipeline.indexAll();
    expect(getSearchCacheStats().size).toBe(0);
  });
});
