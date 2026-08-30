/* TRA-399. Opening a project opens a native macOS tab, and AppKit answers with
   a tab bar — a second top band, on top of the one the app draws. Two things
   have to be re-derived every time the tab count crosses 1, and neither was:

   - the renderer has to reserve the tab bar's height, or the tab bar covers the
     surface toolbar and the sidebar toggle outright;
   - the traffic lights have to be re-placed for the band that now holds them,
     because `trafficLightPosition` is applied once at window creation and
     AppKit re-lays the title bar out underneath it. The window kept an offset
     measured against a band that was no longer there until a resize forced a
     layout pass — which is exactly the "nudge the window and it fixes itself"
     the bug was reported as.

   The old code fired only from `projectWindows.size === 0`, i.e. only when the
   LAST project tab closed, and never touched the button position at all. These
   tests drive the real window events. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAC_TAB_BAR_H,
  TOP_BAND_H,
  TRAFFIC_LIGHT_X,
  TRAFFIC_LIGHT_Y,
  TRAFFIC_LIGHT_Y_TABBED,
  trafficLightCentreY,
  trafficLightYFor,
} from '../../shared/chrome-metrics.js';

/** A stand-in for one BrowserWindow, recording what the app does to its chrome. */
class FakeWindow {
  static all: FakeWindow[] = [];
  handlers = new Map<string, Array<() => void>>();
  buttonPositions: Array<{ x: number; y: number }> = [];
  sent: Array<{ channel: string; args: unknown[] }> = [];
  destroyed = false;
  wcHandlers = new Map<string, Array<() => void>>();
  webContents = {
    id: FakeWindow.all.length + 1,
    isDestroyed: () => this.destroyed,
    send: (channel: string, ...args: unknown[]) => this.sent.push({ channel, args }),
    on: (event: string, fn: () => void) => {
      const list = this.wcHandlers.get(event) ?? [];
      list.push(fn);
      this.wcHandlers.set(event, list);
    },
    emit: (event: string) => {
      for (const fn of this.wcHandlers.get(event) ?? []) fn();
    },
    setWindowOpenHandler: vi.fn(),
  };

  constructor() {
    FakeWindow.all.push(this);
  }

  listen(event: string, fn: () => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
  }
  on = (event: string, fn: () => void) => this.listen(event, fn);
  once = (event: string, fn: () => void) => this.listen(event, fn);
  emit(event: string): void {
    for (const fn of this.handlers.get(event) ?? []) fn();
  }

  isDestroyed = () => this.destroyed;
  setWindowButtonPosition = (p: { x: number; y: number }) => this.buttonPositions.push(p);
  loadURL = () => this.webContents.emit('did-finish-load');
  // Real windows emit these; the events are how the app learns the tab count moved.
  show = () => this.emit('show');
  focus = () => this.emit('focus');
  setTitle = vi.fn();
  addTabbedWindow = vi.fn();

  /** The last chrome state this window was told to adopt. */
  get chrome() {
    const tabbar = this.sent.filter((s) => s.channel === 'tabbar-changed').at(-1);
    return {
      lightY: this.buttonPositions.at(-1)?.y,
      lightX: this.buttonPositions.at(-1)?.x,
      tabBarVisible: tabbar?.args[0],
    };
  }
}

vi.mock('electron', () => ({
  app: { dock: { show: vi.fn(), hide: vi.fn(), setIcon: vi.fn() }, on: vi.fn(), getVersion: () => '0' },
  BrowserWindow: Object.assign(FakeWindow, {
    getAllWindows: () => FakeWindow.all.filter((w) => !w.destroyed),
    getFocusedWindow: () => null,
    fromWebContents: () => null,
  }),
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(() => ({})), setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: vi.fn(), createEmpty: vi.fn(() => ({ addRepresentation: vi.fn() })) },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
  Tray: vi.fn(),
  shell: { openExternal: vi.fn() },
}));

vi.mock('../api-client', () => ({
  DaemonClient: class {
    health = vi.fn();
  },
}));
vi.mock('../daemon-lifecycle', () => ({ ensureDaemon: vi.fn(), restartDaemon: vi.fn() }));
vi.mock('../i18n', () => ({ t: (k: string) => k, startI18n: vi.fn() }));

/**
 * A fresh tray module on a fresh set of windows, with the menu window and one
 * project tab open — the state the bug is reported in. `tray.ts` keeps its
 * windows in module scope, so each test needs its own copy of the module.
 */
async function openMenuAndProject() {
  FakeWindow.all.length = 0;
  vi.resetModules();
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const { showMenuWindow } = await import('../tray.js');
  const { ipcMain } = await import('electron');
  try {
    showMenuWindow();
    const menu = FakeWindow.all[0];
    menu.emit('ready-to-show');

    // Newest registration first: the ipcMain mock outlives vi.resetModules(),
    // so earlier tests' handlers — bound to their own module state — are still
    // in the call list, and the oldest one would open nothing.
    const calls = [...(ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls].reverse();
    const openProject = calls.find((c: unknown[]) => c[0] === 'open-project-tab')?.[1] as (
      event: unknown,
      root: string,
    ) => unknown;
    openProject({}, '/tmp/demo');
    const project = FakeWindow.all[1];
    project.emit('ready-to-show');
    return { menu, project };
  } finally {
    Object.defineProperty(process, 'platform', { value: platform });
  }
}

describe('the traffic lights follow whichever band owns the top line', () => {
  it('centres them in the app band when there is no tab bar', () => {
    expect(trafficLightCentreY(trafficLightYFor(false))).toBe(TOP_BAND_H / 2);
    expect(trafficLightYFor(false)).toBe(TRAFFIC_LIGHT_Y);
  });

  it('centres them in the tab bar when AppKit is drawing one', () => {
    expect(trafficLightCentreY(trafficLightYFor(true))).toBe(MAC_TAB_BAR_H / 2);
    expect(trafficLightYFor(true)).toBe(TRAFFIC_LIGHT_Y_TABBED);
  });

  /* The one assertion the earlier attempts could not have passed. They compared
     the lights against MAC_TAB_BAR_H, which is the number that was wrong, so
     they agreed with themselves and shipped lights 8px (TRA-370) then 4px
     (TRA-432) below the tabs — and stayed green when #659 silently put the
     first value back. MAC_TAB_CENTRE_Y is measured off AppKit
     instead: the selected tab's pill spans y=0.5..17.5 on a 2x capture of a
     real two-tab window (macOS 26.5 / Electron 41.10.6), and the plate it sits
     on ends at y=20.0 — 10 is the line the user sees the tabs on. Re-measure
     it, do not derive it from MAC_TAB_BAR_H (TRA-523). */
  it('puts them on the line the tabs are actually drawn on', () => {
    const MAC_TAB_CENTRE_Y = 10;
    expect(trafficLightCentreY(trafficLightYFor(true))).toBe(MAC_TAB_CENTRE_Y);
  });

  it('does not reuse one offset for both bands', () => {
    expect(TRAFFIC_LIGHT_Y_TABBED).not.toBe(TRAFFIC_LIGHT_Y);
  });
});

describe('window chrome is re-derived when the tab count crosses 1', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('reserves the tab bar and moves the lights into it when a tab opens', async () => {
    const { menu, project } = await openMenuAndProject();
    vi.runAllTimers();

    for (const win of [menu, project]) {
      expect(win.chrome.tabBarVisible).toBe(true);
      expect(win.chrome.lightY).toBe(TRAFFIC_LIGHT_Y_TABBED);
      expect(win.chrome.lightX).toBe(TRAFFIC_LIGHT_X);
    }
  });

  /* The reported bug: after closing back to one tab the lights kept the tabbed
     offset until the window was resized. Nothing re-applied the position. */
  it('puts the lights back on the app band when the tab closes — no resize', async () => {
    const { menu, project } = await openMenuAndProject();
    vi.runAllTimers();

    project.destroyed = true;
    project.emit('closed');
    vi.runAllTimers();

    expect(menu.chrome.tabBarVisible).toBe(false);
    expect(menu.chrome.lightY).toBe(TRAFFIC_LIGHT_Y);
    expect(trafficLightCentreY(menu.chrome.lightY as number)).toBe(TOP_BAND_H / 2);
  });

  /* The old signal was `projectWindows.size === 0`, so closing the MENU tab —
     leaving one project window, no tab bar — told nobody anything. */
  it('reports the tab bar gone when the menu tab is the one that closes', async () => {
    const { menu, project } = await openMenuAndProject();
    vi.runAllTimers();

    menu.destroyed = true;
    menu.emit('closed');
    vi.runAllTimers();

    expect(project.chrome.tabBarVisible).toBe(false);
    expect(project.chrome.lightY).toBe(TRAFFIC_LIGHT_Y);
  });
});
