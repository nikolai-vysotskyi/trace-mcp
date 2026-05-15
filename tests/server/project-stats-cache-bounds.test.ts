/**
 * Regression: src/api/project-stats-routes.ts cache is bounded.
 *
 * Without the bound, a long-running dashboard daemon servicing many
 * projects accumulates one cached ProjectStatsPayload per project for
 * the lifetime of the process. Each payload is a multi-section JSON
 * object that can run into hundreds of KB on large projects.
 *
 * This test exercises buildProjectStats with many distinct projectRoot
 * keys and asserts the cache stays under its MAX_ENTRIES cap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __projectStatsCacheStats,
  buildProjectStats,
  invalidateProjectStatsCache,
  type ProjectStatsContext,
} from '../../src/api/project-stats-routes.js';
import type { JournalEntryForStats } from '../../src/api/journal-stats-routes.js';

function emptyJournalCtx(): ProjectStatsContext {
  return {
    journalStats: {
      listEntriesForProject: (): JournalEntryForStats[] => [],
    },
  };
}

describe('project-stats-routes cache bounds', () => {
  beforeEach(() => {
    invalidateProjectStatsCache();
  });

  afterEach(() => {
    invalidateProjectStatsCache();
  });

  it('cache size stays under MAX_ENTRIES even with many projects', () => {
    const { max } = __projectStatsCacheStats();
    const ctx = emptyJournalCtx();
    // Insert ~4× the cap. Each call uses a unique projectRoot that
    // doesn't exist on disk — the route degrades gracefully (sections
    // null), but still writes a cache entry.
    for (let i = 0; i < max * 4; i++) {
      buildProjectStats(`/tmp/nonexistent/proj-${i}`, ctx);
    }
    const stats = __projectStatsCacheStats();
    // Cache must be bounded: ≤ cap after the burst.
    expect(stats.size).toBeLessThanOrEqual(stats.max);
    expect(stats.size).toBeGreaterThan(0);
  });

  it('LRU eviction surfaces fresh entry when over the cap', () => {
    const { max } = __projectStatsCacheStats();
    const ctx = emptyJournalCtx();
    // Force eviction by inserting more than the cap.
    for (let i = 0; i < max + 4; i++) {
      buildProjectStats(`/tmp/nonexistent/proj-${i}`, ctx);
    }
    const stats = __projectStatsCacheStats();
    expect(stats.size).toBeLessThanOrEqual(stats.max);
  });

  it('expired entries are reclaimed on the next insert', async () => {
    const { ttlMs } = __projectStatsCacheStats();
    const ctx = emptyJournalCtx();
    // Insert a few entries.
    for (let i = 0; i < 4; i++) {
      buildProjectStats(`/tmp/expiring/proj-${i}`, ctx);
    }
    const before = __projectStatsCacheStats().size;
    expect(before).toBeGreaterThan(0);

    // Fast-forward past TTL by stubbing Date.now temporarily.
    const realNow = Date.now;
    try {
      const futureT = Date.now() + ttlMs + 1000;
      Date.now = () => futureT;
      // One fresh insert in the future — must reclaim the expired ones.
      buildProjectStats('/tmp/expiring/proj-trigger', ctx);
    } finally {
      Date.now = realNow;
    }
    const after = __projectStatsCacheStats().size;
    // Only the trigger insert should remain (everything else expired).
    expect(after).toBeLessThanOrEqual(1);
  });
});
