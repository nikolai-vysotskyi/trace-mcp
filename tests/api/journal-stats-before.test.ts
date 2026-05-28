/**
 * Tests for the `before` window-end parameter in src/api/journal-stats-routes.ts
 *
 * Covers the windowing math of `aggregate`:
 *   - Default `before = now`: legacy behaviour, window ends at "now".
 *   - Explicit `before` in the past: recent entries are excluded and only the
 *     older window's entries are counted.
 *   - Boundary inclusivity: entries exactly at `start` and `end` are included.
 *   - by_minute buckets span the requested [start, end] range, not [now-window, now].
 */

import { describe, expect, it } from 'vitest';

import { aggregate, type JournalEntryForStats } from '../../src/api/journal-stats-routes.js';

function entry(ts: number, overrides: Partial<JournalEntryForStats> = {}): JournalEntryForStats {
  return {
    ts,
    tool: 'search',
    params_summary: 'query=foo',
    result_count: 1,
    is_error: false,
    session_id: 's1',
    ...overrides,
  };
}

describe('aggregate — before (window end) parameter', () => {
  const WINDOW_MS = 3_600_000; // 1 hour

  it('default before=now keeps the recent window (backward compatible)', () => {
    const now = Date.now();
    const entries: JournalEntryForStats[] = [
      entry(now - 60_000), // 1 min ago — inside [now - window, now]
      entry(now - 30 * 60_000), // 30 min ago — inside
      entry(now - 2 * WINDOW_MS), // 2 hours ago — outside
    ];

    // No explicit `before` → defaults to now.
    const stats = aggregate(entries, WINDOW_MS);

    expect(stats.total_calls).toBe(2);
    expect(stats.window_ms).toBe(WINDOW_MS);
    // window_end is echoed back and should be ~now.
    expect(stats.window_end).toBeGreaterThanOrEqual(now);
  });

  it('explicit before in the past returns only the older window and excludes recent entries', () => {
    const now = Date.now();
    // Two non-overlapping windows of width WINDOW_MS.
    // Older window: [now - 2*window, now - window]
    // Recent window: [now - window, now]
    const recent = entry(now - 10 * 60_000); // 10 min ago — recent window only
    const older1 = entry(now - WINDOW_MS - 5 * 60_000); // just inside older window
    const older2 = entry(now - 2 * WINDOW_MS + 5 * 60_000); // just inside older window

    const entries = [recent, older1, older2];

    // Ask for the PREVIOUS window: it ends one window-width ago.
    const before = now - WINDOW_MS;
    const stats = aggregate(entries, WINDOW_MS, before);

    // Only the two older-window entries fall in [before - window, before].
    expect(stats.total_calls).toBe(2);
    expect(stats.window_end).toBe(before);
    // The recent entry must NOT leak into the older window.
    const searchTool = stats.hot_tools.find((t) => t.tool === 'search');
    expect(searchTool?.count).toBe(2);
  });

  it('includes entries exactly on the start and end boundaries', () => {
    const before = 10_000_000_000_000; // fixed timestamp, well in the future of test fixtures
    const start = before - WINDOW_MS;
    const entries = [
      entry(start), // exactly at start — inclusive
      entry(before), // exactly at end — inclusive
      entry(start - 1), // one ms before start — excluded
      entry(before + 1), // one ms after end — excluded
    ];

    const stats = aggregate(entries, WINDOW_MS, before);

    expect(stats.total_calls).toBe(2);
  });

  it('by_minute buckets cover the requested window, not now', () => {
    const before = 1_700_000_000_000; // fixed past timestamp
    const stats = aggregate([entry(before - 30_000)], WINDOW_MS, before);

    const minuteMs = 60_000;
    const endFloor = Math.floor(before / minuteMs) * minuteMs;
    const startFloor = Math.floor((before - WINDOW_MS) / minuteMs) * minuteMs;
    const expectedBuckets = (endFloor - startFloor) / minuteMs + 1;

    expect(stats.by_minute.length).toBe(expectedBuckets);
    // First and last buckets bound the requested window.
    expect(stats.by_minute[0].ts).toBe(startFloor);
    expect(stats.by_minute[stats.by_minute.length - 1].ts).toBe(endFloor);
    // The single entry landed in exactly one bucket.
    const totalInBuckets = stats.by_minute.reduce((acc, b) => acc + b.count, 0);
    expect(totalInBuckets).toBe(1);
  });
});
