// @vitest-environment jsdom
/* The renderer half of TRA-297: the app menu owns the keys, this owns what
   they mean. Both halves have to agree — a section list the View menu never
   receives is nine dead shortcuts, and a command nobody handles is a menu item
   that does nothing when clicked. */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { filterItems, matchesQuery, type QuickOpenItem } from '../components/QuickOpen';

type Command = (command: string, arg?: unknown) => void;

let commandHandlers: Command[] = [];
let reportedSections: { id: string; label: string }[] | null = null;

function dispatch(command: string, arg?: unknown): void {
  for (const handler of commandHandlers) handler(command, arg);
}

beforeEach(() => {
  commandHandlers = [];
  reportedSections = null;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    setWindowSections: (sections: { id: string; label: string }[]) => {
      reportedSections = sections;
    },
    onAppCommand: (cb: Command) => {
      commandHandlers.push(cb);
      return () => {
        commandHandlers = commandHandlers.filter((h) => h !== cb);
      };
    },
    openProjectTab: vi.fn(),
    openSettings: vi.fn(),
    selectFolder: vi.fn(async () => null),
    syncSidebarWidth: vi.fn(),
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
  // The onboarding sheet is modal and would swallow the keyboard; it is not
  // what these tests are about.
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

describe('application-menu commands', () => {
  it('reports the menu window’s sections so ⌘1…⌘9 can name them', async () => {
    await renderApp('/?view=menu&tab=workspace');
    expect(reportedSections).toEqual([
      { id: 'workspace', label: 'Workspace' },
      { id: 'clients', label: 'MCP Clients' },
    ]);
  });

  it('reports a project window’s seven sections instead', async () => {
    await renderApp('/?view=project&root=/tmp/proj');
    expect(reportedSections?.map((s) => s.id)).toEqual([
      'overview',
      'ask',
      'graph',
      'activity',
      'memory',
      'notebook',
      'insights',
    ]);
  });

  it('select-section switches the surface', async () => {
    await renderApp('/?view=menu&tab=workspace');
    await act(async () => dispatch('select-section', 2));
    // MCP Clients is ⌘2 in the menu window.
    expect(document.querySelector('.ws-sb-row.is-selected')?.textContent).toContain('MCP Clients');
  });

  it('ignores a section index the window does not have', async () => {
    await renderApp('/?view=menu&tab=workspace');
    await act(async () => dispatch('select-section', 7));
    expect(document.querySelector('.ws-sb-row.is-selected')?.textContent).toContain('Workspace');
  });

  it('toggle-sidebar collapses and restores the sidebar', async () => {
    await renderApp('/?view=menu&tab=workspace');
    expect(document.querySelector('.ws-sidebar')).not.toBeNull();
    await act(async () => dispatch('toggle-sidebar'));
    expect(document.querySelector('.ws-sidebar')).toBeNull();
    await act(async () => dispatch('toggle-sidebar'));
    expect(document.querySelector('.ws-sidebar')).not.toBeNull();
  });

  it('settings opens the Settings surface in the menu window', async () => {
    await renderApp('/?view=menu&tab=workspace');
    await act(async () => dispatch('settings'));
    expect(document.querySelector('.ws-sb-footer .is-selected')).not.toBeNull();
  });

  it('settings hands off to the menu window from a project window', async () => {
    await renderApp('/?view=project&root=/tmp/proj');
    await act(async () => dispatch('settings'));
    expect(window.electronAPI?.openSettings).toHaveBeenCalled();
  });

  it('quick-open opens a dialog listing this window’s sections', async () => {
    await renderApp('/?view=menu&tab=workspace');
    await act(async () => dispatch('quick-open'));
    const dialog = screen.getByRole('dialog', { name: 'Quick open' });
    expect(dialog.textContent).toContain('Workspace');
    expect(dialog.textContent).toContain('MCP Clients');
  });

  it('an unknown command is ignored, not thrown', async () => {
    await renderApp('/?view=menu&tab=workspace');
    expect(() => dispatch('no-such-command')).not.toThrow();
  });
});

describe('quick-open filtering', () => {
  const items: QuickOpenItem[] = [
    { id: 'a', label: 'Workspace', group: 'Go to', icon: 'grid_view', run: () => {} },
    { id: 'b', label: 'MCP Clients', group: 'Go to', icon: 'cable', run: () => {} },
    {
      id: 'c',
      label: 'WorkspaceTableView.tsx',
      detail: 'src/renderer/workspace',
      group: 'Files',
      icon: 'description',
      run: () => {},
    },
  ];

  it('matches a subsequence, not just a prefix', () => {
    expect(matchesQuery('WorkspaceTableView.tsx', 'wtv')).toBe(true);
    expect(matchesQuery('WorkspaceTableView.tsx', 'vtw')).toBe(false);
  });

  it('searches the detail line too, so a path finds its file', () => {
    expect(filterItems(items, 'renderer/workspace').map((i) => i.id)).toEqual(['c']);
  });

  it('an empty query keeps everything', () => {
    expect(filterItems(items, '   ')).toHaveLength(3);
  });
});
