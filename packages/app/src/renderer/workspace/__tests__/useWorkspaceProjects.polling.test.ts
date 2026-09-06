/**
 * @vitest-environment jsdom
 *
 * TRA-1053 — the daemon fills the expensive metrics in a background pass and
 * says `computing: true` until it is done (~18 s across 38 projects). The
 * renderer has to keep asking for the whole of that window.
 *
 * The first attempt gated the re-poll on the `computing` boolean alone. React
 * bails out of a `setState` that does not change a primitive, so the effect
 * re-armed exactly once and the screen then sat on counts-only numbers until
 * the five-minute fallback — the opposite defect from the tight loop we were
 * watching for.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPUTING_POLL_INTERVAL_MS, useWorkspaceProjects } from '../useWorkspaceProjects';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  // The hook also opens an SSE feed via useDaemon; a stub that never emits is
  // enough — this test is only about the metrics poll.
  vi.stubGlobal(
    'EventSource',
    class {
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    },
  );
  fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () =>
      String(url).includes('/api/dashboard/projects')
        ? { projects: [], computing: true }
        : { projects: [] },
  }));
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function dashboardCalls(): number {
  return fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/dashboard/projects'))
    .length;
}

describe('metrics polling while the daemon reports computing', () => {
  it('keeps re-asking every interval, not just once', async () => {
    renderHook(() => useWorkspaceProjects());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initial = dashboardCalls();
    expect(initial).toBeGreaterThan(0);

    for (let round = 1; round <= 3; round++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(COMPUTING_POLL_INTERVAL_MS + 1);
      });
      // One more call per interval. Before the fix this stuck at initial + 1.
      expect(dashboardCalls()).toBe(initial + round);
    }
  });

  it('stops the fast poll once the daemon reports it has finished', async () => {
    renderHook(() => useWorkspaceProjects());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ projects: [], computing: false }),
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPUTING_POLL_INTERVAL_MS + 1);
    });
    const settled = dashboardCalls();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPUTING_POLL_INTERVAL_MS * 5);
    });
    expect(dashboardCalls()).toBe(settled);
  });
});
