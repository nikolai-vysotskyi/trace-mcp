import { describe, expect, it } from 'vitest';
import {
  aggregateHookStats,
  parseDuration,
  parseHookStats,
  renderDaemonEvents,
  renderHookStats,
} from '../../src/cli/daemon-stats.js';

const FIXTURE = [
  '{"ts":1000,"path":"daemon","reason":"ok","wallclock_ms":7}',
  '{"ts":2000,"path":"daemon","reason":"ok","wallclock_ms":12}',
  '{"ts":3000,"path":"daemon","reason":"ok","wallclock_ms":9}',
  '{"ts":4000,"path":"daemon","reason":"ok","wallclock_ms":24}',
  '{"ts":5000,"path":"cli","reason":"no-daemon","wallclock_ms":413}',
  '{"ts":6000,"path":"cli","reason":"no-daemon","wallclock_ms":486}',
  '{"ts":7000,"path":"skipped","reason":"no-daemon","wallclock_ms":3}',
  'not json — should be skipped',
  '{"ts":8000,"path":"daemon"}', // malformed (missing fields) — skipped
].join('\n');

describe('parseHookStats', () => {
  it('parses valid JSONL lines and skips malformed ones', () => {
    const lines = parseHookStats(FIXTURE);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toEqual({ ts: 1000, path: 'daemon', reason: 'ok', wallclock_ms: 7 });
    expect(lines[4].path).toBe('cli');
  });

  it('returns an empty array on empty input', () => {
    expect(parseHookStats('')).toEqual([]);
  });
});

describe('parseDuration', () => {
  it('accepts h/d/m/s suffixes', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('24h')).toBe(24 * 3_600_000);
    expect(parseDuration('7d')).toBe(7 * 86_400_000);
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('45s')).toBe(45_000);
  });

  it('defaults bare integers to hours', () => {
    expect(parseDuration('5')).toBe(5 * 3_600_000);
  });

  it('rejects invalid input', () => {
    expect(parseDuration('foo')).toBeNull();
    expect(parseDuration('-1h')).toBeNull();
    expect(parseDuration('0h')).toBeNull();
  });
});

describe('aggregateHookStats', () => {
  it('computes counts, shares, and percentiles per dispatch path', () => {
    const lines = parseHookStats(FIXTURE);
    const agg = aggregateHookStats(lines, { sinceMs: null });
    expect(agg.total).toBe(7);
    expect(agg.daemon.count).toBe(4);
    expect(agg.cli.count).toBe(2);
    expect(agg.skipped.count).toBe(1);
    expect(agg.daemon.share).toBeCloseTo(4 / 7, 5);
    // p50/p95 over [7,9,12,24] sorted: p50 ≈ floor(0.5*4)=2 → 12; p95 ≈ floor(0.95*4)=3 → 24.
    expect(agg.daemon.p50).toBe(12);
    expect(agg.daemon.p95).toBe(24);
    expect(agg.reasons['no-daemon']).toBe(3);
  });

  it('filters by sinceMs', () => {
    const lines = parseHookStats(FIXTURE);
    const agg = aggregateHookStats(lines, { sinceMs: 5000 });
    expect(agg.total).toBe(3);
    expect(agg.daemon.count).toBe(0);
    expect(agg.cli.count).toBe(2);
  });
});

describe('renderHookStats', () => {
  it('produces a header + sections referencing the window label', () => {
    const lines = parseHookStats(FIXTURE);
    const agg = aggregateHookStats(lines, { sinceMs: null });
    const out = renderHookStats(agg, '24h');
    expect(out).toMatch(/Hook dispatch/);
    expect(out).toMatch(/last 24h/);
    expect(out).toMatch(/total invocations: 7/);
    expect(out).toMatch(/daemon path/);
    expect(out).toMatch(/cli fallback/);
    expect(out).toMatch(/skipped/);
    expect(out).toMatch(/failure reasons/);
  });

  it('handles empty input gracefully', () => {
    const out = renderHookStats(aggregateHookStats([], { sinceMs: null }), '24h');
    expect(out).toMatch(/no hook invocations/);
  });
});

describe('renderDaemonEvents', () => {
  it('renders summary with percentages and percentiles', () => {
    const out = renderDaemonEvents({
      total: 100,
      fast_skipped_recent: 10,
      fast_skipped_hash: 20,
      indexed: 70,
      p50_ms: 180,
      p95_ms: 240,
    });
    expect(out).toMatch(/Daemon reindex events/);
    expect(out).toMatch(/total: 100/);
    expect(out).toMatch(/p50=180ms/);
    expect(out).toMatch(/p95=240ms/);
    expect(out).toMatch(/skipped_recent/);
    expect(out).toMatch(/skipped_hash/);
  });

  it('handles zero events', () => {
    const out = renderDaemonEvents({
      total: 0,
      fast_skipped_recent: 0,
      fast_skipped_hash: 0,
      indexed: 0,
      p50_ms: 0,
      p95_ms: 0,
    });
    expect(out).toMatch(/no reindex-file events/);
  });
});
