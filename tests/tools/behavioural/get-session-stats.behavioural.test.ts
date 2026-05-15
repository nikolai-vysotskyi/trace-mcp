/**
 * Behavioural coverage for `SessionTracker.getSessionStats()` /
 * `getFullStats()` — the engine behind the `get_session_stats` MCP tool.
 *
 * IMPL NOTE: SessionTracker is re-exported from SavingsTracker in
 * `src/savings.ts`. The MCP tool is inline-registered in
 * `src/tools/register/session.ts` and forwards to
 * `savings.getFullStats()` (and reports dedup_saved_tokens from the
 * journal). We assert the underlying SavingsTracker contract (same
 * approach as `get-env-vars.behavioural.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { SessionTracker } from '../../../src/session/tracker.js';

const PROJECT = '/projects/session-stats-fixture';

describe('SessionTracker stats — behavioural contract', () => {
  it('per-tool counts + cumulative totals after recordCall', () => {
    const t = new SessionTracker(PROJECT);
    t.recordCall('get_symbol');
    t.recordCall('get_symbol');
    t.recordCall('search');

    const stats = t.getSessionStats();
    expect(stats.total_calls).toBe(3);
    expect(stats.per_tool.get_symbol.calls).toBe(2);
    expect(stats.per_tool.search.calls).toBe(1);
    expect(stats.total_raw_tokens).toBeGreaterThan(0);
    expect(stats.total_tokens_saved).toBeGreaterThanOrEqual(0);
    expect(stats.reduction_pct).toBeGreaterThanOrEqual(0);
  });

  it('empty session returns zero counters', () => {
    const t = new SessionTracker(PROJECT);
    const stats = t.getSessionStats();
    expect(stats.total_calls).toBe(0);
    expect(stats.total_raw_tokens).toBe(0);
    expect(stats.total_tokens_saved).toBe(0);
    expect(stats.total_actual_tokens).toBe(0);
    expect(stats.per_tool).toEqual({});
    expect(stats.reduction_pct).toBe(0);
  });

  it('per-tool entries carry expected shape', () => {
    const t = new SessionTracker(PROJECT);
    t.recordCall('get_outline');
    const stats = t.getSessionStats();
    const rec = stats.per_tool.get_outline;
    expect(rec).toBeTruthy();
    expect(typeof rec.calls).toBe('number');
    expect(typeof rec.tokens_saved).toBe('number');
    expect(typeof rec.raw_tokens).toBe('number');
    expect(rec.calls).toBe(1);
    expect(rec.raw_tokens).toBeGreaterThan(0);
    // latency_per_tool is present (may be empty if no latency recorded).
    expect(typeof stats.latency_per_tool).toBe('object');
  });

  it('getFullStats exposes session + cumulative envelope (dedup-friendly shape)', () => {
    const t = new SessionTracker(PROJECT);
    t.recordCall('get_symbol');
    const full = t.getFullStats();
    expect(full.session).toBeTruthy();
    expect(full.session.total_calls).toBe(1);
    // cumulative may be null when no prior persistent savings file exists —
    // either way it's a documented field of the envelope.
    expect('cumulative' in full).toBe(true);
  });
});
