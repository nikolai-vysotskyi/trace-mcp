// @vitest-environment jsdom
/* TRA-471. The sidebar's file list has its own state, so the daemon-down answer
   TRA-469 gave the content pane never reached it: a refused socket left
   `files` empty and the list blamed the scope filter for it. An empty list and
   no list are two different facts. */

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

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
