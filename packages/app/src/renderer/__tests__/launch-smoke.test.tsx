// @vitest-environment jsdom
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App';
import { Activity } from '../tabs/Activity';

const now = Date.now();

// Realistic /api/projects/journal/stats payload (matches JournalStats).
const STATS = {
  window_ms: 3_600_000,
  window_end: now,
  total_calls: 42,
  error_rate: 0.07,
  hot_tools: [
    { tool: 'search', count: 20, avg_latency_ms: 12, error_count: 1 },
    { tool: 'get_outline', count: 12, avg_latency_ms: 30, error_count: 0 },
  ],
  hot_files: [{ file: 'src/server.ts', count: 9 }],
  latency_buckets: [
    { bucket_ms: 0, count: 5 },
    { bucket_ms: 10, count: 15 },
    { bucket_ms: 50, count: 10 },
    { bucket_ms: 100, count: 7 },
    { bucket_ms: 500, count: 3 },
    { bucket_ms: 1000, count: 1 },
    { bucket_ms: 5000, count: 1 },
    { bucket_ms: -1, count: 0 },
  ],
  error_groups: [{ tool: 'search', sample_summary: 'q=foo file=src/a.ts', count: 1 }],
  by_minute: Array.from({ length: 60 }, (_, i) => ({
    ts: now - (59 - i) * 60_000,
    count: i % 5,
    error_count: i % 11 === 0 ? 1 : 0,
  })),
};

// Realistic /api/projects/journal snapshot (array of JournalEntry).
const JOURNAL = Array.from({ length: 8 }, (_, i) => ({
  ts: now - i * 1000,
  tool: i % 2 ? 'search' : 'get_outline',
  params_summary: `q=foo file=src/file${i}.ts limit=20`,
  result_count: i,
  result_tokens: i * 10,
  latency_ms: i * 7,
  is_error: i === 3,
  session_id: `sess-${i % 2}`,
}));

function routedFetch(input: RequestInfo | URL): Promise<Response> {
  const u = String(input);
  let body: unknown = { projects: [], files: [] };
  if (u.includes('/api/projects/journal/stats')) body = STATS;
  else if (u.includes('/api/projects/journal')) body = JOURNAL;
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// Minimal stubs so missing Electron/network APIs don't masquerade as the bug.
beforeEach(() => {
  // electron preload bridge — recursive callable proxy. Methods whose name
  // starts with "on" model event subscriptions and return an unsubscribe
  // function (used as an effect cleanup); all others return a resolved Promise
  // (so `await`/`.then`/`.catch` chains don't throw). Faithful enough that the
  // only throws to surface are real component bugs, not stub-shape mismatches.
  const makeApiProxy = (name = ''): unknown =>
    new Proxy(function () {} as object, {
      get: (_t, prop) => makeApiProxy(typeof prop === 'string' ? prop : ''),
      apply: () => (name.startsWith('on') ? () => undefined : Promise.resolve(undefined)),
    });
  (window as unknown as { electronAPI: unknown }).electronAPI = makeApiProxy();
  // fetch — route-aware realistic payloads (stats / journal / generic)
  vi.stubGlobal('fetch', vi.fn(routedFetch));
  // EventSource (SSE) — never used by the menu window but stub defensively
  vi.stubGlobal(
    'EventSource',
    class {
      close() {}
    },
  );
  // matchMedia — present in Electron/Chromium, absent in jsdom
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

it('renders the menu (launch) window without throwing', () => {
  // Default launch URL is the menu window (?view=menu).
  window.history.replaceState({}, '', '/?view=menu&tab=workspace');
  expect(() => render(<App />)).not.toThrow();
});

it('renders the Activity tab with realistic stats + journal data', async () => {
  window.history.replaceState({}, '', '/?view=project&root=/tmp/proj');
  // Capture React DOM-nesting validation errors. A <button> nested inside a
  // <button> is what Chromium reparents, desyncing React and crashing the feed.
  const domErrors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    domErrors.push(args.map(String).join(' '));
  });
  let err: unknown = null;
  try {
    await act(async () => {
      render(<Activity root="/tmp/proj" />);
      // Flush the fetch microtasks so stats/journal land and re-render.
      await Promise.resolve();
      await Promise.resolve();
    });
  } catch (e) {
    err = e;
  } finally {
    spy.mockRestore();
  }
  expect(err).toBeNull();
  const nesting = domErrors.filter(
    (m) => /descendant of <button>/.test(m) || /nested <button>/.test(m),
  );
  expect(nesting, `unexpected DOM-nesting errors:\n${nesting.join('\n')}`).toEqual([]);
});
