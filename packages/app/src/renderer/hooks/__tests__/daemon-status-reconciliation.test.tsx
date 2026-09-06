/**
 * @vitest-environment jsdom
 */
/* TRA-1067 / TRA-1052 cluster. Two failure modes shared one root cause: the
 * project list rendered whatever the LAST event said, and nothing ever asked
 * the daemon again unless a fresh mount or an SSE reconnect happened to do it.
 *
 * 1. The initial indexAll() chain has no dedicated "done" event (unlike
 *    reindex_completed/embed_completed) — its own last progress tick,
 *    `indexing_progress` with `phase: 'completed'`, WAS the terminal signal,
 *    but the handler treated every indexing_progress tick as "still
 *    indexing". A finished project stayed rendered as "Indexing" forever.
 * 2. Even a genuinely lost/misordered terminal event (dropped by a flaky SSE
 *    reconnect, a daemon restart, whatever) had no way to self-correct: fetch
 *    ran once on mount and once on SSE `onopen`, never again.
 *
 * This file locks down the fix for both: the completed-tick branch, and the
 * periodic poll that converges the UI on the daemon's own answer even when no
 * event ever arrives to say so.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROJECT_STATUS_POLL_INTERVAL_MS, useDaemon } from '../useDaemon.js';

const ROOT = '/Users/nikolai/PhpstormProjects/assetfeed';

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  static instances: FakeEventSource[] = [];
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {}
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function jsonResponse(body: unknown) {
  return { ok: true, statusText: 'OK', json: async () => body };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('project status: indexing_progress completion tick', () => {
  it('a "completed" progress tick lands on ready, not a stuck "indexing"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ projects: [{ root: ROOT, status: 'indexing' }] })),
    );
    const { result } = renderHook(() => useDaemon());
    await act(async () => {});

    const es = FakeEventSource.instances[0];
    act(() => {
      es.emit({ type: 'indexing_progress', project: ROOT, phase: 'completed', processed: 43, total: 43 });
    });

    const project = result.current.projects.find((p) => p.root === ROOT);
    expect(project?.status).toBe('ready');
    expect(project?.progress).toBeUndefined();
  });

  it('current >= total also counts as done even without phase: "completed"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ projects: [{ root: ROOT, status: 'indexing' }] })),
    );
    const { result } = renderHook(() => useDaemon());
    await act(async () => {});

    const es = FakeEventSource.instances[0];
    act(() => {
      es.emit({ type: 'indexing_progress', project: ROOT, phase: 'embedding', processed: 10, total: 10 });
    });

    expect(result.current.projects.find((p) => p.root === ROOT)?.status).toBe('ready');
  });

  it('a mid-run tick still reports "indexing" with progress', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ projects: [{ root: ROOT, status: 'indexing' }] })),
    );
    const { result } = renderHook(() => useDaemon());
    await act(async () => {});

    const es = FakeEventSource.instances[0];
    act(() => {
      es.emit({ type: 'indexing_progress', project: ROOT, phase: 'running', processed: 5, total: 43 });
    });

    const project = result.current.projects.find((p) => p.root === ROOT);
    expect(project?.status).toBe('indexing');
    expect(project?.progress).toEqual({ phase: 'running', current: 5, total: 43, percent: 12 });
  });
});

describe('project status: periodic reconciliation with the daemon (TRA-1067 acceptance test)', () => {
  it('converges on the daemon-reported status even when the terminal event is dropped', async () => {
    vi.useFakeTimers();
    // The daemon's own truth changes between polls — simulating the real
    // failure: an SSE event was lost, so the UI's only way to learn the
    // project finished is the next `/api/projects` poll answering 'ready'.
    let daemonStatus = 'indexing';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ projects: [{ root: ROOT, status: daemonStatus }] })),
    );

    const { result } = renderHook(() => useDaemon());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    expect(result.current.projects.find((p) => p.root === ROOT)?.status).toBe('indexing');

    // The daemon finished. No SSE event announces it — the completion event
    // is simply never delivered (the exact scenario a dropped/misordered SSE
    // message produces).
    daemonStatus = 'ready';

    // Nothing short of the periodic poll should change this — advancing by
    // less than the interval must NOT flip the status yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROJECT_STATUS_POLL_INTERVAL_MS - 1000);
    });
    expect(result.current.projects.find((p) => p.root === ROOT)?.status).toBe('indexing');

    // Crossing the poll interval reconciles state with the daemon's answer —
    // this is the safety net a dropped event can no longer defeat.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.projects.find((p) => p.root === ROOT)?.status).toBe('ready');
  });

  it('does not poll while the window is hidden', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    let daemonStatus = 'indexing';
    const fetchMock = vi.fn(async () => jsonResponse({ projects: [{ root: ROOT, status: daemonStatus }] }));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useDaemon());
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const callsAfterMount = fetchMock.mock.calls.length;

    daemonStatus = 'ready';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROJECT_STATUS_POLL_INTERVAL_MS * 3);
    });

    // Only the mount-time fetches (projects/clients/settings) — no
    // hidden-window polling burning cycles against a daemon the user isn't
    // even looking at (mirrors the SSE visibility gate, TRA-526).
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);
  });
});
