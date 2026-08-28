/**
 * TRA-264 — a failed metrics fetch must not be reported as loaded, or the KPI
 * strip swaps its `—` placeholders for hard zeros and presents the failure as
 * real data.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeMetricsError, fetchMetricsOnce } from '../useWorkspaceProjects';

const setters = () => ({ setMetrics: vi.fn(), setError: vi.fn() });

afterEach(() => vi.unstubAllGlobals());

describe('fetchMetricsOnce', () => {
  it('returns true and clears the error on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ projects: [{ root: '/a' }] }) }),
    );
    const s = setters();
    expect(await fetchMetricsOnce(s)).toBe(true);
    expect(s.setMetrics).toHaveBeenCalledWith([{ root: '/a' }]);
    expect(s.setError).toHaveBeenCalledWith(null);
  });

  it('returns false on a network failure and never publishes metrics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const s = setters();
    expect(await fetchMetricsOnce(s)).toBe(false);
    expect(s.setMetrics).not.toHaveBeenCalled();
  });

  it('returns false on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    const s = setters();
    expect(await fetchMetricsOnce(s)).toBe(false);
    expect(s.setError).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
  });
});

describe('describeMetricsError', () => {
  it('replaces raw transport messages with an actionable one', () => {
    for (const raw of ['Failed to fetch', 'Load failed', 'The operation was aborted', 'timed out']) {
      expect(describeMetricsError(new Error(raw))).toBe(
        "Couldn't load project metrics — daemon not responding.",
      );
    }
  });

  it('keeps a meaningful server message', () => {
    expect(describeMetricsError(new Error('cache rebuild failed'))).toContain('cache rebuild failed');
  });
});
