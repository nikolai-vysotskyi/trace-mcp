/* menu.ts — the application menu (TRA-297).

   Until now the app shipped Electron's default menu: no Settings item, no
   app-specific commands, no accelerators. A Mac app is judged by its keyboard,
   and every shortcut the user reaches for first (⌘, ⌘R ⌘F ⌘1…⌘9) lives here.

   Two halves:

   - Items the OS or Electron can service alone (Edit roles, zoom, window roles)
     are plain `role` entries — they keep working inside text fields for free.
   - Everything app-specific dispatches ONE IPC message, `app-command`, to the
     focused window. The renderer owns what a command means on the surface the
     user is looking at; the menu owns only the key that triggers it.

   The View menu's section list is per-window: the menu window has Workspace /
   MCP clients, a project window has Overview … Insights. The renderer reports
   its own list over `window-sections` on mount, we cache it per webContents id,
   and rebuild the menu whenever a window takes focus. That keeps the labels and
   their ⌘1…⌘9 numbering in one place (App.tsx) instead of duplicated here. */

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import { type GlobalActionId, globalAction } from '../shared/global-actions.js';
import { showMenuWindow } from './tray';

const isMac = process.platform === 'darwin';

const DOCS_URL = 'https://github.com/nikolai-vysotskyi/trace-mcp#readme';

export interface WindowSection {
  id: string;
  label: string;
}

/** webContents.id → the sections that window's sidebar currently offers. */
const sectionsByWebContents = new Map<number, WindowSection[]>();

export function setWindowSections(webContentsId: number, sections: WindowSection[]): void {
  sectionsByWebContents.set(webContentsId, sections.slice(0, 9));
  // The focused window is the one whose sections the View menu shows, so a
  // late report (renderer mounted after focus) has to redraw the menu.
  if (BrowserWindow.getFocusedWindow()?.webContents.id === webContentsId) installAppMenu();
}

export function forgetWindowSections(webContentsId: number): void {
  sectionsByWebContents.delete(webContentsId);
}

function send(command: string, arg?: unknown): void {
  const win = BrowserWindow.getFocusedWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('app-command', command, arg);
}

/** ⌘⇧W: with native tabs, ⌘W closes the tab and ⌘⇧W closes the whole window.
    Electron exposes no tab-group membership, and this app runs exactly one
    group, so "every window" and "this window's tabs" are the same set. */
function closeWindowGroup(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.close();
  }
}

/** One item of the shared global-action list (TRA-363). The sidebar's app menu
    renders the SAME entry, so the label and the key are read here, never typed
    here — that is the whole point of `src/shared/global-actions.ts`. */
function actionItem(id: GlobalActionId): MenuItemConstructorOptions {
  const action = globalAction(id);
  const url = action.url;
  return url
    ? { label: action.label, click: () => void shell.openExternal(url) }
    : { label: action.label, accelerator: action.accelerator, click: () => send(action.id) };
}

function sectionItems(): MenuItemConstructorOptions[] {
  const focused = BrowserWindow.getFocusedWindow();
  const sections = focused ? (sectionsByWebContents.get(focused.webContents.id) ?? []) : [];
  return sections.map((section, i) => ({
    label: section.label,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => send('select-section', i + 1),
  }));
}

export function buildAppMenu(): Menu {
  const sections = sectionItems();

  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about' },
      actionItem('check-for-update'),
      { type: 'separator' },
      actionItem('settings'),
      { type: 'separator' },
      ...(isMac
        ? ([
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
          ] as MenuItemConstructorOptions[])
        : []),
      { role: 'quit' },
    ],
  };

  /* Off macOS there is no app menu, so Settings and Quit would have no home at
     all — they go to the bottom of File, which is where Windows and Linux users
     look for them anyway. Ctrl+, still works; the accelerator is the same. */
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      // The menu window IS this app's main window: ⌘N creates it when it has
      // been closed, and brings it forward when it hasn't.
      { label: 'New window', accelerator: 'CmdOrCtrl+N', click: () => showMenuWindow() },
      { label: 'Open project…', accelerator: 'CmdOrCtrl+O', click: () => send('open-project') },
      { label: 'Quick open…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('quick-open') },
      { type: 'separator' },
      { label: 'Close tab', accelerator: 'CmdOrCtrl+W', role: 'close' },
      { label: 'Close window', accelerator: 'CmdOrCtrl+Shift+W', click: closeWindowGroup },
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            actionItem('settings'),
            { type: 'separator' },
            { role: 'quit' },
          ] as MenuItemConstructorOptions[])),
    ],
  };

  // Plain roles, so undo/redo/cut/copy/paste keep working inside every text
  // field — that is what they are here for, not decoration.
  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      {
        label: 'Toggle sidebar',
        accelerator: 'CmdOrCtrl+Alt+S',
        click: () => send('toggle-sidebar'),
      },
      ...(sections.length > 0
        ? ([{ type: 'separator' }, ...sections] as MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', role: 'reload' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    role: 'window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? ([
            { type: 'separator' },
            { role: 'selectNextTab' },
            { role: 'selectPreviousTab' },
            { role: 'toggleTabBar' },
            { role: 'mergeAllWindows' },
            { type: 'separator' },
            { role: 'front' },
          ] as MenuItemConstructorOptions[])
        : []),
    ],
  };

  // Plain label, no `role: 'help'`: AppKit recognises a menu titled "Help" and
  // adds the system Help search to it itself.
  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      // "Documentation", not the old "trace-mcp help": next to the shared
      // "Get help" item, two things called help and pointing at different
      // pages is a coin toss.
      { label: 'Documentation', click: () => void shell.openExternal(DOCS_URL) },
      actionItem('get-help'),
      actionItem('view-changelog'),
      // On macOS these live in the app menu; elsewhere Help is where they go.
      ...(isMac
        ? []
        : ([
            { type: 'separator' },
            actionItem('check-for-update'),
            { role: 'about' },
          ] as MenuItemConstructorOptions[])),
    ],
  };

  return Menu.buildFromTemplate([
    ...(isMac ? [appMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ]);
}

export function installAppMenu(): void {
  Menu.setApplicationMenu(buildAppMenu());
}

/** Call once from whenReady. Rebuilds on focus so ⌘1…⌘9 always name the
    sections of the window the user is actually looking at. */
export function registerAppMenu(): void {
  ipcMain.on('window-sections', (event, sections: WindowSection[]) => {
    if (!Array.isArray(sections)) return;
    setWindowSections(event.sender.id, sections);
    event.sender.once('destroyed', () => forgetWindowSections(event.sender.id));
  });
  installAppMenu();
  app.on('browser-window-focus', () => installAppMenu());
}
