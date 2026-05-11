/**
 * Tests for the GET /api/stats endpoint surface.
 *
 * The cli.ts handler is a long-running HTTP server that's expensive to spin
 * up in a unit test. We exercise the exact same code path the handler does:
 *   - load reindex-stats + parseDuration via dynamic import
 *   - parse `?since=` into ms
 *   - call getReindexStats().summarize(sinceMs)
 *   - JSON-serialise the summary
 *
 * If any of these contracts breaks the route silently degrades, so a unit
 * test on the surface is the right granularity.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDuration } from '../../src/cli/daemon-stats.js';
import {
  __resetReindexStatsForTests,
  getReindexStats,
  type ReindexStatsSummary,
} from '../../src/daemon/reindex-stats.js';

/**
 * Reimplementation of the inline /api/stats handler body from cli.ts. Keeping
 * the test in lockstep with the handler ensures we catch shape drift.
 */
async function statsHandlerEquivalent(sinceParam: string | null): Promise<ReindexStatsSummary> {
  const { getReindexStats: getStats } = await import('../../src/daemon/reindex-stats.js');
  const { parseDuration: parseDur } = await import('../../src/cli/daemon-stats.js');
  const sinceMs = sinceParam ? (parseDur(sinceParam) ?? undefined) : undefined;
  return getStats().summarize(sinceMs);
}

describe('GET /api/stats endpoint surface', () => {
  beforeEach(() => {
    __resetReindexStatsForTests();
  });

  afterEach(() => {
    __resetReindexStatsForTests();
  });

  it('returns a summary with the expected shape', async () => {
    getReindexStats().record({
      pathSource: 'http',
      skippedRecent: false,
      skippedHash: false,
      indexed: 1,
      elapsedMs: 10,
    });

    const out = await statsHandlerEquivalent(null);
    expect(out).toMatchObject({
      total: 1,
      fast_skipped_recent: 0,
      fast_skipped_hash: 0,
      indexed: 1,
    });
    expect(typeof out.p50_ms).toBe('number');
    expect(typeof out.p95_ms).toBe('number');
  });

  it('respects optional ?since=1h to filter older events', async () => {
    const now = Date.now();
    const TWO_HOURS = 2 * 3_600_000;
    // Old event (>1h ago)
    getReindexStats().record({
      ts: now - TWO_HOURS,
      pathSource: 'http',
      skippedRecent: false,
      skippedHash: false,
      indexed: 1,
      elapsedMs: 100,
    });
    // Recent event (just now)
    getReindexStats().record({
      ts: now,
      pathSource: 'http',
      skippedRecent: false,
      skippedHash: true,
      indexed: 0,
      elapsedMs: 5,
    });

    // No filter: both events visible.
    const all = await statsHandlerEquivalent(null);
    expect(all.total).toBe(2);

    // since=1h: only the recent event.
    const recent = await statsHandlerEquivalent('1h');
    expect(recent.total).toBe(1);
    expect(recent.fast_skipped_hash).toBe(1);
    expect(recent.indexed).toBe(0);
  });

  it('parseDuration accepts s/m/h/d suffixes', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('45s')).toBe(45_000);
    expect(parseDuration('2d')).toBe(2 * 86_400_000);
    // bare number → hours by default (matches CLI semantics)
    expect(parseDuration('6')).toBe(6 * 3_600_000);
    expect(parseDuration('garbage')).toBe(null);
  });

  it('ignores ?since on malformed input (graceful degradation)', async () => {
    getReindexStats().record({
      pathSource: 'http',
      skippedRecent: false,
      skippedHash: false,
      indexed: 1,
      elapsedMs: 1,
    });
    // parseDuration returns null for garbage; handler treats that as no filter.
    const out = await statsHandlerEquivalent('garbage');
    expect(out.total).toBe(1);
  });
});
