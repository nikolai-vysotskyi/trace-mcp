/* The application menu is the app's keyboard contract (TRA-297): if an
   accelerator silently disappears from this template, the shortcut it names
   stops existing and nothing else in the suite notices. These tests pin the
   accelerators, the per-window ⌘1…⌘9 section list, and the one thing that is
   easy to get wrong — a menu that dispatches to a window that has gone away. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Item {
  label?: string;
  role?: string;
  type?: string;
  accelerator?: string;
  click?: () => void;
  submenu?: Item[];
}

const sent: { command: string; arg?: unknown }[] = [];
let focusedId: number | null = 1;
let template: Item[] = [];

const focusedWindow = {
  isDestroyed: () => false,
  webContents: {
    get id() {
      return focusedId ?? 0;
    },
    isDestroyed: () => false,
    send: (_channel: string, command: string, arg?: unknown) => sent.push({ command, arg }),
  },
};

vi.mock('electron', () => ({
  app: { name: 'trace-mcp', on: vi.fn() },
  BrowserWindow: {
    getFocusedWindow: () => (focusedId === null ? null : focusedWindow),
    getAllWindows: () => [],
  },
  ipcMain: { on: vi.fn() },
  Menu: {
    buildFromTemplate: (t: Item[]) => {
      template = t;
      return t;
    },
    setApplicationMenu: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../tray', () => ({ showMenuWindow: vi.fn(), refreshTrayMenu: vi.fn() }));

import { GLOBAL_ACTIONS } from '../../shared/global-actions.js';
import { startI18n, t } from '../i18n';
import { buildAppMenu, forgetWindowSections, setWindowSections } from '../menu';

function menu(label: string): Item[] {
  const found = template.find((m) => m.label === label);
  if (!found?.submenu) throw new Error(`no "${label}" menu in the template`);
  return found.submenu;
}

/** Every accelerator in the whole menu, flattened. Deliberately not scoped to
    one menu: Settings and Quit live in the app menu on macOS and at the bottom
    of File everywhere else, and the promise being tested is that the KEY works,
    not where the item sits. CI runs this on Linux and a dev runs it on macOS. */
function accelerators(): Map<string, string> {
  const out = new Map<string, string>();
  for (const top of template) {
    for (const item of top.submenu ?? []) {
      if (item.accelerator && item.label) out.set(item.label, item.accelerator);
    }
  }
  return out;
}

function click(items: Item[], label: string): void {
  const item = items.find((i) => i.label === label);
  if (!item?.click) throw new Error(`"${label}" has no click handler`);
  item.click();
}

beforeEach(() => {
  sent.length = 0;
  focusedId = 1;
  forgetWindowSections(1);
  buildAppMenu();
});

describe('application menu', () => {
  it('carries the shortcuts the app promises', () => {
    const keys = accelerators();
    expect(keys.get('Settings…')).toBe('CmdOrCtrl+,');
    expect(keys.get('Find')).toBe('CmdOrCtrl+F');
    expect(keys.get('Toggle sidebar')).toBe('CmdOrCtrl+Alt+S');
    expect(keys.get('Quick open…')).toBe('CmdOrCtrl+Shift+O');
    expect(keys.get('Open project…')).toBe('CmdOrCtrl+O');
    expect(keys.get('New window')).toBe('CmdOrCtrl+N');
    expect(keys.get('Close tab')).toBe('CmdOrCtrl+W');
    expect(keys.get('Close window')).toBe('CmdOrCtrl+Shift+W');
    expect(keys.get('Reload')).toBe('CmdOrCtrl+R');
  });

  /* TRA-363: the sidebar's app menu offers the same four actions. Both lists
     are built from src/shared/global-actions.ts, and this is the half of that
     promise the main process can check — that every shared action is actually
     ON the native menu, under its own label. The renderer's half lives in
     renderer/components/__tests__/AppMenu.test.tsx. */
  it('carries every shared global action, by the shared label', () => {
    const labels = template.flatMap((top) => (top.submenu ?? []).map((i) => i.label));
    for (const action of GLOBAL_ACTIONS) {
      expect(labels).toContain(t(action.labelKey));
    }
  });

  it('sends the shared list’s URL actions to the browser, not to a window', () => {
    click(menu('Help'), 'Get help');
    click(menu('Help'), 'View changelog');
    expect(sent).toEqual([]); // neither is an app-command
  });

  it('keeps Edit on plain roles so text fields keep working', () => {
    const roles = menu('Edit')
      .map((i) => i.role)
      .filter(Boolean);
    expect(roles).toEqual(
      expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']),
    );
  });

  it('dispatches app-specific items to the focused window', () => {
    click(menu('View'), 'Toggle sidebar');
    click(menu('Edit'), 'Find');
    expect(sent).toEqual([{ command: 'toggle-sidebar' }, { command: 'find' }]);
  });

  it('numbers the focused window’s own sections ⌘1…⌘n', () => {
    setWindowSections(1, [
      { id: 'overview', label: 'Overview' },
      { id: 'ask', label: 'Ask' },
      { id: 'graph', label: 'Graph' },
    ]);
    buildAppMenu();
    const view = menu('View');
    expect(view.find((i) => i.label === 'Overview')?.accelerator).toBe('CmdOrCtrl+1');
    expect(view.find((i) => i.label === 'Graph')?.accelerator).toBe('CmdOrCtrl+3');

    click(view, 'Graph');
    expect(sent).toEqual([{ command: 'select-section', arg: 3 }]);
  });

  it('caps the section list at the nine keys that exist', () => {
    setWindowSections(
      1,
      Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, label: `Section ${i}` })),
    );
    buildAppMenu();
    const numbered = menu('View').filter((i) => /^CmdOrCtrl\+\d$/.test(i.accelerator ?? ''));
    expect(numbered).toHaveLength(9);
  });

  it('shows no section items for a window that never reported any', () => {
    focusedId = 99;
    buildAppMenu();
    expect(menu('View').some((i) => /^CmdOrCtrl\+\d$/.test(i.accelerator ?? ''))).toBe(false);
  });

  /* CI caught this the hard way: the first version built the app menu only on
     macOS, so on Windows and Linux — where the app also ships — Settings and
     Quit had no home at all and ⌘, was dead. */
  it('keeps Settings and Quit reachable on Windows and Linux', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      vi.resetModules();
      // `.js` — the main tsconfig is on node16 resolution, which requires the
      // extension on a dynamic import even though the static one above is fine.
      const { buildAppMenu: buildForLinux } = await import('../menu.js');
      buildForLinux();
      expect(template[0].label).toBe('File'); // no app menu off macOS
      const file = menu('File').map((i) => i.label ?? i.role);
      expect(file).toContain('Settings…');
      expect(file).toContain('quit');
      expect(accelerators().get('Settings…')).toBe('CmdOrCtrl+,');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
      vi.resetModules();
    }
  });

  /* TRA-386: `Menu.setApplicationMenu` replaces the menu wholesale, so a
     language change has to rebuild every label — a bar half in Russian is the
     failure this pins. */
  it('rebuilds every top-level title in the active language', () => {
    startI18n('ru');
    try {
      buildAppMenu();
      const titles = template.map((m) => m.label);
      expect(titles).toContain('Файл');
      expect(titles).toContain('Справка');
      expect(menu('Правка').map((i) => i.label ?? i.role)).toContain('Найти');
    } finally {
      startI18n('en');
      buildAppMenu();
    }
  });

  it('drops the command instead of throwing when no window has focus', () => {
    const items = menu('View');
    focusedId = null;
    expect(() => click(items, 'Toggle sidebar')).not.toThrow();
    expect(sent).toEqual([]);
  });
});
