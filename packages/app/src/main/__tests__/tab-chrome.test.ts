/* TRA-587. Native macOS tabs with titleBarStyle: 'hiddenInset' resulted in a
   squashed, broken NSTabBar rendered at the top edge of the window, misaligned
   traffic lights, and layout distortion. Each window (Workspace + individual
   projects) opens as a clean independent window on macOS with consistent chrome. */

import { describe, expect, it, vi } from 'vitest';
import {
  TOP_BAND_H,
  TRAFFIC_LIGHT_D,
  TRAFFIC_LIGHT_X,
  TRAFFIC_LIGHT_Y,
  trafficLightCentreY,
} from '../../shared/chrome-metrics.js';

/** A stand-in for one BrowserWindow, recording what the app does to its chrome. */
class FakeWindow {
  static all: FakeWindow[] = [];
  opts: Record<string, unknown>;
  handlers = new Map<string, Array<() => void>>();
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

  constructor(opts: Record<string, unknown> = {}) {
    this.opts = opts;
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
  loadURL = () => this.webContents.emit('did-finish-load');
  show = () => this.emit('show');
  focus = () => this.emit('focus');
  setTitle = vi.fn();
  addTabbedWindow = vi.fn();
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

describe('the traffic lights sit on the top band centre line', () => {
  it('centres them in the 44px top band', () => {
    expect(trafficLightCentreY()).toBe(TOP_BAND_H / 2);
    expect(TRAFFIC_LIGHT_Y).toBe((TOP_BAND_H - TRAFFIC_LIGHT_D) / 2 - 1);
  });

  it('sets consistent traffic light coordinates on window creation', async () => {
    FakeWindow.all.length = 0;
    vi.resetModules();
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { showMenuWindow } = await import('../tray.js');
    try {
      showMenuWindow();
      const menu = FakeWindow.all[0];
      expect(menu.opts.trafficLightPosition).toEqual({
        x: TRAFFIC_LIGHT_X,
        y: TRAFFIC_LIGHT_Y,
      });
      // No tabbingIdentifier on macOS — prevents broken native NSTabBar
      expect(menu.opts.tabbingIdentifier).toBeUndefined();
      expect(menu.addTabbedWindow).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });

  it('opens project windows independently without attaching native tabs', async () => {
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

      const calls = [...(ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls].reverse();
      const openProject = calls.find((c: unknown[]) => c[0] === 'open-project-tab')?.[1] as (
        event: unknown,
        root: string,
      ) => unknown;
      openProject({}, '/tmp/demo');
      const project = FakeWindow.all[1];
      project.emit('ready-to-show');

      expect(menu.addTabbedWindow).not.toHaveBeenCalled();
      expect(project.opts.tabbingIdentifier).toBeUndefined();
      expect(project.opts.trafficLightPosition).toEqual({
        x: TRAFFIC_LIGHT_X,
        y: TRAFFIC_LIGHT_Y,
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });
});

