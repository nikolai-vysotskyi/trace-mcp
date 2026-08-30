/**
 * @vitest-environment jsdom
 */
/* TRA-526. Every project tab is its own BrowserWindow, and `useDaemon` used to
 * open an EventSource unconditionally — one permanently-held socket per tab.
 * Chromium allows six connections per host and the daemon is one host, so from
 * the sixth window on every fetch to it queued behind the streams and timed out
 * after DAEMON_FETCH_TIMEOUT_MS. Measured: the fifth project tab's Overview
 * never loaded, while the same daemon answered a Node client in 1 ms.
 *
 * The guard is the socket count, not the wall-clock: N mounted windows of which
 * one is on screen must hold ONE stream, and unmounting must leave none. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDaemon } from '../hooks/useDaemon.js';

/** Live EventSources, the way the browser's socket pool sees them. */
let open = 0;
let visibility: DocumentVisibilityState = 'visible';

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  constructor(readonly url: string) {
    open++;
  }
  close() {
    open--;
  }
}

beforeEach(() => {
  open = 0;
  visibility = 'visible';
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('daemon SSE sockets', () => {
  it('a window that is not on screen holds no stream', async () => {
    visibility = 'hidden';
    const { unmount } = renderHook(() => useDaemon());
    await act(async () => {});
    expect(open).toBe(0);
    unmount();
  });

  it('six mounted windows with one on screen hold one stream between them', async () => {
    // The visible one.
    const front = renderHook(() => useDaemon());
    await act(async () => {});
    expect(open).toBe(1);

    // Five more tabs behind it. Chromium's budget is six per host; anything
    // that grows with the tab count here is the regression.
    visibility = 'hidden';
    const back = [];
    for (let i = 0; i < 5; i++) {
      back.push(renderHook(() => useDaemon()));
      await act(async () => {});
    }
    expect(open).toBe(1);

    for (const h of back) h.unmount();
    front.unmount();
    expect(open).toBe(0);
  });

  it('releases the stream when the window goes off screen, and takes it back', async () => {
    const { unmount } = renderHook(() => useDaemon());
    await act(async () => {});
    expect(open).toBe(1);

    setVisibility('hidden');
    expect(open).toBe(0);

    setVisibility('visible');
    expect(open).toBe(1);

    unmount();
    expect(open).toBe(0);
  });
});
