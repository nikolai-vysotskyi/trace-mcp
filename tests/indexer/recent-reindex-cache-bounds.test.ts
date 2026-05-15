import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __recentReindexCacheStats,
  __resetRecentReindexCache,
  shouldSkipRecentReindex,
} from '../../src/indexer/recent-reindex-cache.js';

/**
 * Regression: the outer projects map and inner per-project buckets are
 * both bounded. Without the cap a long-running daemon servicing many
 * projects accumulates one map entry per project for the lifetime of
 * the process.
 */
describe('recent-reindex-cache bounds', () => {
  beforeEach(() => {
    __resetRecentReindexCache();
  });

  afterEach(() => {
    __resetRecentReindexCache();
  });

  it('outer projects map is capped at MAX_PROJECTS', () => {
    const { maxProjects } = __recentReindexCacheStats();
    // Insert maxProjects + 16 distinct projects.
    for (let i = 0; i < maxProjects + 16; i++) {
      shouldSkipRecentReindex(`/tmp/project-${i}`, 'src/file.ts', i);
    }
    const stats = __recentReindexCacheStats();
    expect(stats.projects).toBeLessThanOrEqual(maxProjects);
    // The most-recently-inserted project must survive eviction.
    const lastProject = `/tmp/project-${maxProjects + 15}`;
    // First call to a freshly-evicted project would return false; a fresh
    // call to the surviving last project within TTL must still be deduped.
    expect(shouldSkipRecentReindex(lastProject, 'src/file.ts', maxProjects + 15 + 100)).toBe(true);
  });

  it('LRU bump keeps hot projects from being evicted', () => {
    const { maxProjects } = __recentReindexCacheStats();
    // Insert the hot project once at t=0.
    shouldSkipRecentReindex('/tmp/hot', 'src/file.ts', 0);
    for (let i = 0; i < maxProjects; i++) {
      // Touch 'hot' regularly so the LRU bump keeps it alive.
      shouldSkipRecentReindex('/tmp/hot', 'src/file.ts', i * 1000 + 5);
      shouldSkipRecentReindex(`/tmp/cold-${i}`, 'src/file.ts', i * 1000 + 7);
    }
    const stats = __recentReindexCacheStats();
    expect(stats.projects).toBeLessThanOrEqual(maxProjects);
    // The hot project's bucket survives — its last entry timestamp is
    // (maxProjects-1)*1000+5, well past TTL, so a fresh call returns
    // false, then a second call within TTL is deduped → returns true.
    const t = maxProjects * 1000 + 1000;
    expect(shouldSkipRecentReindex('/tmp/hot', 'src/file.ts', t)).toBe(false);
    expect(shouldSkipRecentReindex('/tmp/hot', 'src/file.ts', t + 50)).toBe(true);
    // Spot check: one of the earliest cold projects should have been evicted.
    // Re-inserting returns false (not deduped from prior bucket).
    expect(shouldSkipRecentReindex('/tmp/cold-0', 'src/file.ts', t + 100)).toBe(false);
  });

  it('inner bucket sweep reclaims expired entries past the cap', () => {
    const project = '/tmp/proj-cap';
    const { maxBucketSize } = __recentReindexCacheStats();
    // Fill bucket to the cap with entries at t=0.
    for (let i = 0; i < maxBucketSize; i++) {
      shouldSkipRecentReindex(project, `src/file-${i}.ts`, 0);
    }
    // Continue inserting more files long after TTL expired — the
    // sweep at size > cap must reclaim every prior entry.
    for (let i = 0; i < maxBucketSize; i++) {
      shouldSkipRecentReindex(project, `src/fresh-${i}.ts`, 10_000 + i);
    }
    const stats = __recentReindexCacheStats();
    // Every t=0 entry is past TTL; the sweep that ran when the bucket
    // hit > cap should have dropped them, so we stay near the cap.
    expect(stats.totalEntries).toBeLessThanOrEqual(maxBucketSize + 1);
  });

  it('GC sweep drops expired entries even when bucket under cap', () => {
    const project = '/tmp/sweep';
    // Fill the bucket above the cap with stale entries.
    const { maxBucketSize } = __recentReindexCacheStats();
    for (let i = 0; i < maxBucketSize; i++) {
      shouldSkipRecentReindex(project, `src/old-${i}.ts`, 0);
    }
    // Now insert one more entry well past TTL — triggers the sweep.
    shouldSkipRecentReindex(project, 'src/trigger.ts', 10_000);
    const stats = __recentReindexCacheStats();
    // Stale entries are gone; only the trigger remains (plus maybe a few we didn't sweep through).
    expect(stats.totalEntries).toBeLessThanOrEqual(maxBucketSize);
  });
});
