import { describe, expect, it } from 'vitest';
import { SavingsTracker } from '../src/savings.js';

describe('SavingsTracker latency telemetry', () => {
  it('returns null for tools with no recorded calls', () => {
    const t = new SavingsTracker('/tmp/test');
    expect(t.getLatencyStats('search')).toBeNull();
  });

  it('reports p50/p95/max from recorded durations', () => {
    const t = new SavingsTracker('/tmp/test');
    for (const d of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      t.recordLatency('search', d);
    }
    const stats = t.getLatencyStats('search');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(10);
    expect(stats!.errors).toBe(0);
    expect(stats!.error_rate).toBe(0);
    // p50 of 10..100 (linear-interp) = 55
    expect(stats!.p50).toBeCloseTo(55, 5);
    expect(stats!.max).toBe(100);
    // p95 = 95.5
    expect(stats!.p95).toBeGreaterThan(90);
  });

  it('tracks errors and computes error_rate correctly', () => {
    const t = new SavingsTracker('/tmp/test');
    t.recordLatency('search', 5, false);
    t.recordLatency('search', 5, true);
    t.recordLatency('search', 5, false);
    t.recordLatency('search', 5, true);
    const stats = t.getLatencyStats('search');
    expect(stats!.errors).toBe(2);
    expect(stats!.count).toBe(4);
    expect(stats!.error_rate).toBeCloseTo(0.5, 5);
  });

  it('caps the duration ring buffer at the configured window', () => {
    const t = new SavingsTracker('/tmp/test');
    // Push 250 calls — only the last 200 should be retained for percentile math.
    for (let i = 1; i <= 250; i += 1) t.recordLatency('search', i);
    const stats = t.getLatencyStats('search')!;
    expect(stats.count).toBe(250); // total counter is unbounded
    expect(stats.window).toBe(200);
    // Max in the retained window is the last value pushed (250).
    expect(stats.max).toBe(250);
    // p50 of the retained window is around (51..250 midpoint) = 150.5
    expect(stats.p50).toBeGreaterThan(140);
    expect(stats.p50).toBeLessThan(160);
  });

  it('exposes latency_per_tool only for tools with at least one call', () => {
    const t = new SavingsTracker('/tmp/test');
    t.recordLatency('search', 5);
    t.recordLatency('get_outline', 8);
    const all = t.getLatencyPerTool();
    expect(Object.keys(all).sort()).toEqual(['get_outline', 'search']);
  });

  it('includes latency_per_tool in getSessionStats output', () => {
    const t = new SavingsTracker('/tmp/test');
    t.recordCall('search');
    t.recordLatency('search', 12);
    const stats = t.getSessionStats();
    expect(stats.total_calls).toBe(1);
    expect(stats.latency_per_tool.search).toBeDefined();
    expect(stats.latency_per_tool.search.count).toBe(1);
  });

  it('ignores non-finite or negative durations', () => {
    const t = new SavingsTracker('/tmp/test');
    t.recordLatency('search', Number.NaN);
    t.recordLatency('search', -1);
    t.recordLatency('search', 10);
    const stats = t.getLatencyStats('search')!;
    expect(stats.count).toBe(3); // total counter still increments
    expect(stats.window).toBe(1); // only the valid duration was retained
    expect(stats.max).toBe(10);
  });
});
