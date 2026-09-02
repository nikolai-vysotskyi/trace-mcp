// @vitest-environment jsdom
/* TRA-700 — App.tsx owns the tab list and switches the mounted view in
   place. There is one BrowserWindow for the whole app (TRA-699): opening a
   project is a local state update fed by `open-tab` / `new-tab` / `focus-tab`
   IPC from main, not a window focus round trip. */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

type OpenTabHandler = (payload: { root: string }) => void;
type VoidHandler = () => void;
type FocusTabHandler = (tabId: string) => void;

let openTabHandlers: OpenTabHandler[] = [];
let newTabHandlers: VoidHandler[] = [];
let focusTabHandlers: FocusTabHandler[] = [];

const emitOpenTab = (root: string) => {
  for (const h of openTabHandlers) h({ root });
};
const emitNewTab = () => {
  for (const h of newTabHandlers) h();
};
const emitFocusTab = (tabId: string) => {
  for (const h of focusTabHandlers) h(tabId);
};

beforeEach(() => {
  openTabHandlers = [];
  newTabHandlers = [];
  focusTabHandlers = [];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getPlatform: vi.fn(async () => 'darwin'),
    onOpenTab: (cb: OpenTabHandler) => {
      openTabHandlers.push(cb);
      return () => {
        openTabHandlers = openTabHandlers.filter((h) => h !== cb);
      };
    },
    onNewTab: (cb: VoidHandler) => {
      newTabHandlers.push(cb);
      return () => {
        newTabHandlers = newTabHandlers.filter((h) => h !== cb);
      };
    },
    onFocusTab: (cb: FocusTabHandler) => {
      focusTabHandlers.push(cb);
      return () => {
        focusTabHandlers = focusTabHandlers.filter((h) => h !== cb);
      };
    },
    setWindowSections: vi.fn(),
    onAppCommand: vi.fn(() => () => {}),
    openProjectTab: vi.fn(),
    openSettings: vi.fn(),
    selectFolder: vi.fn(async () => null),
    syncSidebarWidth: vi.fn(),
    onSidebarWidthChanged: vi.fn(() => () => {}),
    onFullscreenChanged: vi.fn(() => () => {}),
    checkForUpdate: vi.fn(async () => ({ available: false })),
    checkPendingUpdate: vi.fn(async () => ({ pending: false })),
    openInEditor: vi.fn(),
    guard: {
      checkCliVersion: vi.fn(async () => ({
        current: '2.1.0',
        required: '2.1.0',
        ok: true,
        needsUpgrade: false,
        notInstalled: false,
      })),
      installStatus: vi.fn(async () => ({ claudeDetected: false, installed: false })),
    },
  };
  localStorage.clear();
  localStorage.setItem('trace-mcp.onboarded.v1', '1');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ projects: [], files: [] }), { status: 200 })),
  );
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
  vi.stubGlobal(
    'EventSource',
    class {
      close() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderApp(search: string): Promise<void> {
  window.history.replaceState({}, '', search);
  await act(async () => {
    render(<App />);
  });
}

/* Inactive tabs stay mounted (hidden via `display:none`), so a plain
   `document.querySelector('.ws-sb-row.is-selected')` can match a hidden
   tab's row instead of the visible one — walk up for an inline
   `display:none` ancestor to find the row that is actually on screen. */
function isHidden(el: Element | null): boolean {
  for (let node = el; node; node = node.parentElement) {
    if (node instanceof HTMLElement && node.style.display === 'none') return true;
  }
  return false;
}

function visibleText(selector: string): string | null {
  const els = document.querySelectorAll<HTMLElement>(selector);
  return Array.from(els).find((el) => !isHidden(el))?.textContent ?? null;
}

describe('tab bar ownership', () => {
  it('starts with no strip for a single tab', async () => {
    await renderApp('/?view=menu&tab=workspace');
    expect(document.querySelector('[data-tabbar]')?.getAttribute('data-tabbar')).toBe('off');
  });

  it('mounts a new tab locally when main sends open-tab, no window focus IPC involved', async () => {
    await renderApp('/?view=menu&tab=workspace');

    await act(async () => emitOpenTab('/projects/assetfeed'));

    expect(screen.getByTitle('/projects/assetfeed')).toBeTruthy();
    expect(document.querySelector('[data-tabbar]')?.getAttribute('data-tabbar')).toBe('on');
  });

  it('re-focuses an already-open project tab instead of duplicating it', async () => {
    await renderApp('/?view=menu&tab=workspace');

    await act(async () => emitOpenTab('/projects/assetfeed'));
    await act(async () => emitOpenTab('/projects/assetfeed'));

    expect(screen.getAllByTitle('/projects/assetfeed')).toHaveLength(1);
  });

  it('new-tab from main opens (or focuses) the menu tab', async () => {
    await renderApp('/?view=project&root=/projects/assetfeed');

    await act(async () => emitNewTab());

    expect(screen.getByTitle('Menu')).toBeTruthy();
    expect(visibleText('.ws-sb-row.is-selected')).toContain('Workspace');
  });

  it('focus-tab from main switches the active tab locally', async () => {
    await renderApp('/?view=menu&tab=workspace');
    await act(async () => emitOpenTab('/projects/assetfeed'));

    // Opening activated the project tab; focus-tab('menu') should hand it back.
    await act(async () => emitFocusTab('menu'));

    expect(visibleText('.ws-sidebar')).toContain('Workspace');
  });

  it('switching tabs keeps each tab’s own state alive instead of resetting it', async () => {
    await renderApp('/?view=menu&tab=workspace');

    // Change the menu tab's own section before a second tab exists.
    fireEvent.click(screen.getByText('MCP Clients'));
    expect(visibleText('.ws-sb-row.is-selected')).toContain('MCP Clients');

    // Opening a project tab mounts a second tab and activates it — the menu
    // tab is now hidden, not unmounted.
    await act(async () => emitOpenTab('/projects/assetfeed'));

    // Switch back to the menu tab via the strip.
    fireEvent.click(screen.getByTitle('Menu'));

    expect(visibleText('.ws-sb-row.is-selected')).toContain('MCP Clients');
  });

  it('closing the only project tab falls back to the menu view', async () => {
    await renderApp('/?view=menu&tab=workspace');
    await act(async () => emitOpenTab('/projects/assetfeed'));
    expect(screen.getByTitle('/projects/assetfeed')).toBeTruthy();

    const closeBtn = screen.getByRole('button', { name: /close/i });
    await act(async () => fireEvent.click(closeBtn));

    expect(screen.queryByTitle('/projects/assetfeed')).toBeNull();
    expect(visibleText('.ws-sidebar')).toContain('Workspace');
  });

  it('Cmd/Ctrl+T opens (or focuses) the menu tab', async () => {
    await renderApp('/?view=project&root=/projects/assetfeed');

    await act(async () => {
      fireEvent.keyDown(window, { key: 't', metaKey: true });
    });

    expect(screen.getByTitle('Menu')).toBeTruthy();
    expect(visibleText('.ws-sb-row.is-selected')).toContain('Workspace');
  });

  it('Ctrl+Tab cycles the active tab', async () => {
    await renderApp('/?view=menu&tab=workspace');
    await act(async () => emitOpenTab('/projects/assetfeed'));

    // Opening the project tab activated it; Ctrl+Tab should cycle back to menu.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true });
    });

    expect(visibleText('.ws-sidebar')).toContain('Workspace');
  });

  /* main/menu.ts no longer accelerates CmdOrCtrl+W or CmdOrCtrl+1…9 — this
     handler owns both outright now (TRA-700 review). */
  it('Cmd/Ctrl+W closes the active project tab, falling back to the menu tab', async () => {
    await renderApp('/?view=menu&tab=workspace');
    await act(async () => emitOpenTab('/projects/assetfeed'));
    expect(screen.getByTitle('/projects/assetfeed')).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'w', metaKey: true });
    });

    expect(screen.queryByTitle('/projects/assetfeed')).toBeNull();
    expect(visibleText('.ws-sidebar')).toContain('Workspace');
  });

  it('Cmd/Ctrl+W on the menu tab is a no-op — the menu tab is never closable', async () => {
    await renderApp('/?view=menu&tab=workspace');

    await act(async () => {
      fireEvent.keyDown(window, { key: 'w', metaKey: true });
    });

    expect(document.querySelector('.ws-sidebar')).not.toBeNull();
  });

  it('Cmd/Ctrl+1…9 selects a tab by position', async () => {
    await renderApp('/?view=menu&tab=workspace');
    await act(async () => emitOpenTab('/projects/assetfeed'));
    // Opening activated the project tab (position 2); ⌘1 should hand focus
    // back to the menu tab at position 1.
    expect(visibleText('.ws-sidebar')).not.toContain('Workspace');

    await act(async () => {
      fireEvent.keyDown(window, { key: '1', metaKey: true });
    });

    expect(visibleText('.ws-sidebar')).toContain('Workspace');

    await act(async () => {
      fireEvent.keyDown(window, { key: '2', metaKey: true });
    });

    expect(screen.getByTitle('/projects/assetfeed')).toBeTruthy();
    expect(visibleText('.ws-sidebar')).not.toContain('Workspace');
  });

  /* Regression for the review finding on #807: useUpdateCheck() used to live
     inside AppTabView, so every kept-alive tab started its own poller and
     update-progress subscription — N mounted tabs, N update checks. It now
     lives in the shell and is passed down, so opening a second tab must not
     trigger a second check. */
  it('shares one update check across every mounted tab, not one per tab', async () => {
    const api = window.electronAPI as unknown as { checkForUpdate: ReturnType<typeof vi.fn> };
    await renderApp('/?view=menu&tab=workspace');
    expect(api.checkForUpdate).toHaveBeenCalledTimes(1);

    await act(async () => emitOpenTab('/projects/assetfeed'));

    expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it('Cmd/Ctrl+N (beyond the open tab count) is a no-op', async () => {
    await renderApp('/?view=menu&tab=workspace');

    await act(async () => {
      fireEvent.keyDown(window, { key: '2', metaKey: true });
    });

    expect(document.querySelector('[data-tabbar]')?.getAttribute('data-tabbar')).toBe('off');
  });
});
