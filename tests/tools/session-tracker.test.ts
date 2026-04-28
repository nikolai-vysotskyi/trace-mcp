import { describe, expect, it } from 'vitest';
import { SavingsTracker } from '../../src/savings.js';

describe('Session Tracker (Token Savings)', () => {
  it('records tool calls and computes savings', () => {
    const tracker = new SavingsTracker('/tmp/test');
    tracker.recordCall('get_outline', 150);
    tracker.recordCall('search', 100);
    tracker.recordCall('get_symbol', 120);

    const stats = tracker.getSessionStats();
    expect(stats.total_calls).toBe(3);
    expect(stats.total_tokens_saved).toBeGreaterThan(0);
    expect(stats.total_raw_tokens).toBeGreaterThan(0);
    expect(stats.total_actual_tokens).toBe(370); // 150 + 100 + 120
    expect(stats.reduction_pct).toBeGreaterThan(0);
  });

  it('tracks per-tool breakdown', () => {
    const tracker = new SavingsTracker('/tmp/test');
    tracker.recordCall('search', 50);
    tracker.recordCall('search', 75);
    tracker.recordCall('get_outline', 200);

    const stats = tracker.getSessionStats();
    expect(stats.per_tool.search.calls).toBe(2);
    expect(stats.per_tool.get_outline.calls).toBe(1);
    expect(stats.per_tool.search.tokens_saved).toBeGreaterThan(0);
  });

  it('handles unknown tool names with default cost', () => {
    const tracker = new SavingsTracker('/tmp/test');
    tracker.recordCall('unknown_tool', 100);

    const stats = tracker.getSessionStats();
    expect(stats.total_calls).toBe(1);
    expect(stats.per_tool.unknown_tool.calls).toBe(1);
  });

  it('computes reduction percentage correctly', () => {
    const tracker = new SavingsTracker('/tmp/test');
    // Raw cost for get_outline is 1200, actual is 100 → saved 1100
    tracker.recordCall('get_outline', 100);

    const stats = tracker.getSessionStats();
    // reduction = 1100 / 1200 * 100 ≈ 92%
    expect(stats.reduction_pct).toBeGreaterThan(80);
    expect(stats.reduction_pct).toBeLessThanOrEqual(100);
  });

  it('returns full stats with cumulative data', () => {
    const tracker = new SavingsTracker('/tmp/test');
    tracker.recordCall('search', 50);

    const full = tracker.getFullStats();
    expect(full.session.total_calls).toBe(1);
    // Cumulative may be null if no persistent file
    expect(full).toHaveProperty('cumulative');
  });

  it('does not leak memory with many calls', () => {
    const tracker = new SavingsTracker('/tmp/test');
    for (let i = 0; i < 10000; i++) {
      tracker.recordCall('search', 50);
    }
    const stats = tracker.getSessionStats();
    expect(stats.total_calls).toBe(10000);
    // Per-tool map should have exactly 1 entry, not 10000
    expect(Object.keys(stats.per_tool).length).toBe(1);
  });
});
