/**
 * @vitest-environment jsdom
 *
 * TRA-264 — a failed metrics fetch must not be reported as loaded, or the KPI
 * strip swaps its `—` placeholders for hard zeros and presents the failure as
 * real data.
 *
 * TRA-397 — and it must not throw the previous numbers away either. A slow
 * daemon is one state, not three escalating ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyMetricsError,
  deriveDaemonState,
  fetchMetricsOnce,
  loadMetricsSnapshot,
  saveMetricsSnapshot,
} from '../useWorkspaceProjects';
import type { ProjectHealthMetrics } from '../types';

const setters = () => ({ setMetrics: vi.fn(), setErrorKind: vi.fn() });

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
    expect(s.setErrorKind).toHaveBeenCalledWith(null);
  });

  it('returns false on a network failure and never publishes metrics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const s = setters();
    expect(await fetchMetricsOnce(s)).toBe(false);
    expect(s.setMetrics).not.toHaveBeenCalled();
    expect(s.setErrorKind).toHaveBeenCalledWith('offline');
  });

  it('returns false on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    const s = setters();
    expect(await fetchMetricsOnce(s)).toBe(false);
    expect(s.setErrorKind).toHaveBeenCalledWith('server');
  });

  // TRA-292: a daemon alive on /health but eight seconds deep in indexing
  // eighty projects is slow, not unreachable. Saying "not reachable" sends the
  // user to restart a service that is working.
  it('calls a timeout slow, not unreachable', () => {
    for (const err of [new Error('The operation was aborted'), new Error('signal timed out')]) {
      expect(classifyMetricsError(err)).toBe('timeout');
    }
    expect(classifyMetricsError({ name: 'TimeoutError', message: '' })).toBe('timeout');
    expect(classifyMetricsError(new Error('cache rebuild failed'))).toBe('server');
  });
});

describe('deriveDaemonState', () => {
  const base = { loading: false, connected: true, liveProjects: 3, metricsErrorKind: null };

  it('is ok while the daemon has not answered yet', () => {
    // Not "failing" — not asked yet. The skeleton owns this moment.
    expect(deriveDaemonState({ ...base, loading: true, connected: false, liveProjects: 0 })).toBe(
      'ok',
    );
  });

  it('is ok when everything answers', () => {
    expect(deriveDaemonState(base)).toBe('ok');
  });

  // The three banners the user cycled through were these three inputs.
  it('reads every degraded input as the same one state', () => {
    expect(deriveDaemonState({ ...base, metricsErrorKind: 'timeout' })).toBe('stale');
    expect(deriveDaemonState({ ...base, metricsErrorKind: 'offline' })).toBe('stale');
    expect(deriveDaemonState({ ...base, metricsErrorKind: 'server' })).toBe('stale');
    expect(deriveDaemonState({ ...base, connected: false })).toBe('stale');
  });

  it('keeps a daemon that never answered at all distinct', () => {
    expect(deriveDaemonState({ ...base, connected: false, liveProjects: 0 })).toBe('unreachable');
  });

  /**
   * TRA-525: measured on Nikolai's Mac, indexing starves the daemon's event
   * loop to a /health p50 of 7.8s, so a cold-started daemon can be running hard
   * and still look, from the renderer, exactly like a daemon that isn't there.
   * "The daemon isn't running" then offers to start something already started.
   */
  const mute = { ...base, connected: false, liveProjects: 0 };

  it('does not say "isn\'t running" about a process that is provably running', () => {
    expect(deriveDaemonState({ ...mute, processAlive: true })).toBe('stale');
  });

  it('still says "isn\'t running" when the process really is gone', () => {
    expect(deriveDaemonState({ ...mute, processAlive: false })).toBe('unreachable');
  });

  it('falls back to the old reading when liveness is unknown', () => {
    // undefined = the main-process bridge has not answered yet. Guessing
    // "alive" would suppress a real DaemonDownPane; only a definite true wins.
    expect(deriveDaemonState({ ...mute, processAlive: undefined })).toBe('unreachable');
  });

  it('does not upgrade a degraded-but-connected daemon just because it is alive', () => {
    expect(deriveDaemonState({ ...base, metricsErrorKind: 'timeout', processAlive: true })).toBe(
      'stale',
    );
    expect(deriveDaemonState({ ...base, processAlive: true })).toBe('ok');
  });
});

describe('metrics snapshot', () => {
  const rows = [{ root: '/a', name: 'a', totalFiles: 12 }] as unknown as ProjectHealthMetrics[];

  beforeEach(() => localStorage.clear());

  it('round-trips the last successful response', () => {
    saveMetricsSnapshot(rows);
    expect(loadMetricsSnapshot()).toEqual(rows);
  });

  it('starts cold rather than throwing on a corrupted snapshot', () => {
    localStorage.setItem('trace-mcp.workspace.metrics', '{not json');
    expect(loadMetricsSnapshot()).toEqual([]);
    localStorage.setItem('trace-mcp.workspace.metrics', '"a string"');
    expect(loadMetricsSnapshot()).toEqual([]);
  });
});
