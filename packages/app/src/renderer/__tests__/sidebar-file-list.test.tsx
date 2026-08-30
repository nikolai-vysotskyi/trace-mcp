// @vitest-environment jsdom
/* TRA-471. The sidebar's file list has its own state, so the daemon-down answer
   TRA-469 gave the content pane never reached it: a refused socket left
   `files` empty and the list blamed the scope filter for it. An empty list and
   no list are two different facts. */

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { DAEMON_FETCH_TIMEOUT_MS } from '../hooks/useDaemon';

const SCOPE_LINE = 'No indexed files match this scope.';

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    setWindowSections: vi.fn(),
    onAppCommand: vi.fn(() => () => {}),
    openProjectTab: vi.fn(),
    openSettings: vi.fn(),
    selectFolder: vi.fn(async () => null),
    syncSidebarWidth: vi.fn(),
    checkForUpdate: vi.fn(async () => ({ available: false })),
    checkPendingUpdate: vi.fn(async () => ({ pending: false })),
    openInEditor: vi.fn(),
  };
  localStorage.clear();
  localStorage.setItem('trace-mcp.onboarded.v1', '1');
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderProjectWindow(): Promise<void> {
  window.history.replaceState({}, '', '/?view=project&root=/tmp/proj');
  await act(async () => {
    render(<App />);
  });
}

describe('sidebar file list, empty', () => {
  it('blames the scope when the daemon answered with no files', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ files: [] }), { status: 200 })),
    );
    await renderProjectWindow();
    expect(document.body.textContent).toContain(SCOPE_LINE);
  });

  it('says nothing when the daemon never answered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    await renderProjectWindow();
    expect(document.body.textContent).not.toContain(SCOPE_LINE);
  });

  /* A 500 is not a scope filter either — the list is missing for a reason the
     sidebar cannot name, same as a refused connection. */
  it('says nothing when the daemon answered with an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await renderProjectWindow();
    expect(document.body.textContent).not.toContain(SCOPE_LINE);
  });
});

/* TRA-478. Every case above rejects immediately, which is the one shape of
   "daemon down" that was never broken. A wedged daemon still holds :3741 open,
   so the connect never completes and the promise never settles — and the list
   pulsed six skeletons forever, telling a screen reader it was still loading.
   The request needs a deadline; the render needs a terminal state to reach. */
describe('sidebar file list, daemon reachable but never answering', () => {
  it('leaves the loading state when the request hits its deadline', async () => {
    /* The deadline is driven by hand rather than by advancing timers:
       `AbortSignal.timeout` schedules inside the platform, where a fake clock
       does not reach it. Standing in for it also proves the component asked for
       one at all — on the code this test pins, it never did. */
    const deadlines: number[] = [];
    /* Every deadline in the window, not just the last one: the daemon poll asks
       for its own, and the file list's is not reliably the most recent. */
    const expire: (() => void)[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      deadlines.push(ms);
      const controller = new AbortController();
      expire.push(() => controller.abort(new DOMException('timed out', 'TimeoutError')));
      return controller.signal;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          // A wedged daemon: the socket is open, so nothing but the deadline ends this.
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    try {
      await renderProjectWindow();
      expect(deadlines).toContain(DAEMON_FETCH_TIMEOUT_MS);
      // Still in flight, so the skeletons are right to be up.
      expect(document.querySelectorAll('.ws-sb-skeleton').length).toBeGreaterThan(0);

      await act(async () => {
        for (const fire of expire) fire();
      });
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(document.querySelectorAll('.ws-sb-skeleton')).toHaveLength(0);
    expect(document.querySelectorAll('[aria-busy="true"]')).toHaveLength(0);
    // Still not the scope's fault — nothing ever came back.
    expect(document.body.textContent).not.toContain(SCOPE_LINE);
  });
});
