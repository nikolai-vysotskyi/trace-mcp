import path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Tray } from 'electron';
import { DaemonClient } from './api-client';
import { ensureDaemon, restartDaemon } from './daemon-lifecycle';

const isMac = process.platform === 'darwin';

// macOS: Template images (auto-tinted by the system)
// Windows: separate light/dark icons (white for dark taskbar, black for light)
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

function getTrayIconPaths(): { active: string; inactive: string } {
  if (isMac) {
    return {
      active: path.join(ASSETS, 'tray-iconTemplate.png'),
      inactive: path.join(ASSETS, 'tray-icon-dimTemplate.png'),
    };
  }
  // Windows/Linux: pick icon color based on system theme
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return {
    active: path.join(ASSETS, `tray-icon-${theme}.png`),
    inactive: path.join(ASSETS, `tray-icon-dim-${theme}.png`),
  };
}

const TABBING_ID = 'trace-mcp-tabs';

let tray: Tray;
let menuWindow: BrowserWindow | null = null;
const projectWindows = new Map<string, BrowserWindow>(); // root → window
let healthInterval: ReturnType<typeof setInterval>;
let daemonReachable = false;
/**
 * Consecutive failed health checks since the daemon was last seen alive.
 * Drives exponential-backoff restart attempts: we retry on 1st, 3rd, 6th,
 * 12th, 24th failure, then every 24 subsequent failures (~2 min at 5s poll).
 */
let consecutiveFailures = 0;
/** Ticks at which we will attempt a restart. Must match the description above. */
const RESTART_ATTEMPT_TICKS = new Set<number>([1, 3, 6, 12, 24]);
/** After the last explicit tick, retry every N ticks. */
const RESTART_RETRY_EVERY = 24;
let _lastRestartAttempt = 0;
/**
 * Timestamp of the last daemon restart triggered by a version mismatch.
 * Used to back off so a stuck daemon (one that comes back up still reporting
 * the wrong version) doesn't drive us into a restart loop.
 */
let lastVersionMismatchRestart = 0;
const VERSION_MISMATCH_RESTART_COOLDOWN_MS = 60_000;

const daemon = new DaemonClient();

function getRendererUrl(params?: Record<string, string>): string {
  const base = `file://${path.join(__dirname, '..', 'renderer', 'index.html')}`;
  if (!params || Object.keys(params).length === 0) return base;
  const qs = new URLSearchParams(params).toString();
  return `${base}?${qs}`;
}

function getTitleBarColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f6f6f6';
}

function createWindowOptions(
  extraOpts?: Partial<Electron.BrowserWindowConstructorOptions>,
): Electron.BrowserWindowConstructorOptions {
  const opts: Electron.BrowserWindowConstructorOptions = {
    width: 960,
    height: 700,
    show: false,
    icon: APP_ICON,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    backgroundColor: getTitleBarColor(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    ...extraOpts,
  };
  // tabbingIdentifier is macOS-only
  if (isMac) {
    opts.tabbingIdentifier = TABBING_ID;
  }
  return opts;
}

function safeSend(win: BrowserWindow | null, channel: string, ...args: unknown[]): void {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send(channel, ...args);
  } catch {
    // webContents may be destroyed between the guard and the send call
  }
}

function setupWindowEvents(win: BrowserWindow): void {
  win.on('enter-full-screen', () => safeSend(win, 'fullscreen-changed', true));
  win.on('leave-full-screen', () => safeSend(win, 'fullscreen-changed', false));

  // Auto-reload on renderer crash (GPU crash, OOM, etc.)
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[trace-mcp] renderer crashed in window: reason=${details.reason}`);
    if (!win.isDestroyed() && details.reason !== 'clean-exit') {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          try {
            win.webContents.reload();
          } catch {
            /* destroyed mid-reload */
          }
        }
      }, 1000);
    }
  });

  // Handle unresponsive renderer
  win.on('unresponsive', () => {
    console.warn('[trace-mcp] window became unresponsive, reloading...');
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      try {
        win.webContents.reload();
      } catch {
        /* destroyed mid-reload */
      }
    }
  });
}

function ensureDockVisible(): void {
  if (isMac) {
    app.dock?.show();
    app.dock?.setIcon(nativeImage.createFromPath(APP_ICON));
  }
}

/** Notify ALL windows whether the native tab bar is visible (macOS) */
function broadcastTabBar(visible: boolean): void {
  const allWindows = [menuWindow, ...projectWindows.values()];
  for (const win of allWindows) {
    safeSend(win, 'tabbar-changed', visible);
  }
}

// ── Custom tab bar for Windows ─────────────────────────────────
// On macOS we use native tabs. On Windows we broadcast a tab list
// to every window so the renderer can draw its own tab strip.

interface TabInfo {
  id: string; // 'menu' or project root path
  title: string;
  type: 'menu' | 'project';
  active: boolean;
}

function getTabList(focusedWebContentsId?: number): TabInfo[] {
  const tabs: TabInfo[] = [];
  if (menuWindow && !menuWindow.isDestroyed()) {
    tabs.push({
      id: 'menu',
      title: 'Menu',
      type: 'menu',
      active: menuWindow.webContents.id === focusedWebContentsId,
    });
  }
  for (const [root, win] of projectWindows) {
    if (!win.isDestroyed()) {
      const sep = process.platform === 'win32' ? '\\' : '/';
      tabs.push({
        id: root,
        title: root.split(sep).filter(Boolean).pop() || root,
        type: 'project',
        active: win.webContents.id === focusedWebContentsId,
      });
    }
  }
  return tabs;
}

function broadcastTabList(): void {
  if (isMac) return; // macOS uses native tabs
  const allWindows = [menuWindow, ...projectWindows.values()];
  const focusedWin = BrowserWindow.getFocusedWindow();
  const tabs = getTabList(focusedWin?.webContents.id);
  for (const win of allWindows) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) continue;
    // Send tab list with 'active' relative to each window
    const tabsForWin = tabs.map((t) => ({
      ...t,
      active:
        win.webContents.id ===
        (t.id === 'menu' ? menuWindow?.webContents.id : projectWindows.get(t.id)?.webContents.id),
    }));
    safeSend(win, 'tab-list-changed', tabsForWin);
  }
}

// IPC: focus a tab by id (Windows custom tab bar)
ipcMain.handle('focus-tab', (_event, tabId: string) => {
  if (tabId === 'menu') {
    if (menuWindow && !menuWindow.isDestroyed()) {
      menuWindow.focus();
    }
  } else {
    const win = projectWindows.get(tabId);
    if (win && !win.isDestroyed()) {
      win.focus();
    }
  }
  broadcastTabList();
  return { ok: true };
});

// IPC: open settings window (optionally navigating to a specific section via ?section= query param)
ipcMain.handle('open-settings', (_event: Electron.IpcMainInvokeEvent, section?: string) => {
  showMenuWindow('settings');
  // Inject section param by reloading with the extra query param
  if (section && menuWindow && !menuWindow.isDestroyed()) {
    const base = `file://${path.join(__dirname, '..', 'renderer', 'index.html')}`;
    const qs = new URLSearchParams({ view: 'menu', tab: 'settings', section }).toString();
    menuWindow.loadURL(`${base}?${qs}`);
  }
  return { ok: true };
});

// IPC: get current platform (renderer needs this to decide whether to show custom tabs)
ipcMain.handle('get-platform', () => process.platform);

function hideDockIfNoWindows(): void {
  if (isMac && !menuWindow && projectWindows.size === 0) {
    app.dock?.hide();
  }
}

export function showMenuWindow(tab?: string): void {
  if (menuWindow && !menuWindow.isDestroyed()) {
    if (tab) {
      menuWindow.loadURL(getRendererUrl({ view: 'menu', tab }));
    }
    ensureDockVisible();
    menuWindow.show();
    menuWindow.focus();
    return;
  }

  menuWindow = new BrowserWindow(createWindowOptions());
  menuWindow.loadURL(getRendererUrl({ view: 'menu', ...(tab ? { tab } : {}) }));

  // Attach to existing tab group if project windows are open (macOS only)
  if (isMac) {
    const existingTab = [...projectWindows.values()].find((w) => !w.isDestroyed());
    if (existingTab) {
      existingTab.addTabbedWindow(menuWindow);
    }
  }

  menuWindow.webContents.on('did-finish-load', () => {
    menuWindow?.setTitle('Menu');
  });

  menuWindow.once('ready-to-show', () => {
    ensureDockVisible();
    menuWindow?.show();
    menuWindow?.focus();
    broadcastTabList();
  });

  setupWindowEvents(menuWindow);

  menuWindow.on('closed', () => {
    menuWindow = null;
    hideDockIfNoWindows();
    broadcastTabList();
  });

  menuWindow.on('focus', () => broadcastTabList());
}

function openProjectTab(root: string): void {
  // If project already open, focus its tab
  const existing = projectWindows.get(root);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  // Ensure menu window exists first (it becomes the first tab)
  if (!menuWindow || menuWindow.isDestroyed()) {
    showMenuWindow();
  }

  const win = new BrowserWindow(createWindowOptions());
  projectWindows.set(root, win);

  win.loadURL(getRendererUrl({ view: 'project', root }));

  // Attach as a native macOS tab to the menu window
  if (isMac && menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.addTabbedWindow(win);
  }

  win.once('ready-to-show', () => {
    ensureDockVisible();
    win.show();
    win.focus();
    // First project tab opened → tab bar is now visible (macOS native tabs)
    if (isMac) {
      broadcastTabBar(true);
    }
    broadcastTabList();
  });

  setupWindowEvents(win);

  // Set tab title to project name
  const sep = process.platform === 'win32' ? '\\' : '/';
  const projectName = root.split(sep).filter(Boolean).pop() || root;
  win.webContents.on('did-finish-load', () => {
    win.setTitle(projectName);
  });

  win.on('closed', () => {
    projectWindows.delete(root);
    // If no more project tabs, tab bar disappears (only menu window left)
    if (isMac && projectWindows.size === 0) {
      broadcastTabBar(false);
    }
    hideDockIfNoWindows();
    broadcastTabList();
  });

  win.on('focus', () => broadcastTabList());
}

// IPC: open a project as a native tab
ipcMain.handle('open-project-tab', (_event, root: string) => {
  openProjectTab(root);
  return { ok: true };
});

// IPC: close the current tab/window
ipcMain.handle('close-current-tab', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
  return { ok: true };
});

// IPC: sync sidebar width across all tabbed windows
ipcMain.on('sync-sidebar-width', (event, width: number) => {
  const sender = event.sender;
  const allWindows = [menuWindow, ...projectWindows.values()];
  for (const win of allWindows) {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed() && win.webContents !== sender) {
      safeSend(win, 'sidebar-width-changed', width);
    }
  }
});

function showWindow(tab?: string): void {
  showMenuWindow(tab);
}

function createDotIcon(hex: string, glow: boolean): Electron.NativeImage {
  const scale = 2;
  const r = 4 * scale;
  const glowR = glow ? 3 * scale : 0;
  const w = (r + glowR) * 2; // tight width — no extra left padding
  const h = 16 * scale; // full menu item height
  const cx = r + glowR; // circle flush to left edge
  const cy = h / 2;

  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);

  const buf = Buffer.alloc(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const idx = (y * w + x) * 4;

      if (dist <= r) {
        buf[idx] = red;
        buf[idx + 1] = green;
        buf[idx + 2] = blue;
        buf[idx + 3] = 255;
      } else if (glow && dist <= r + 3 * scale) {
        const alpha = Math.round(255 * Math.max(0, 1 - (dist - r) / (3 * scale)) * 0.4);
        buf[idx] = red;
        buf[idx + 1] = green;
        buf[idx + 2] = blue;
        buf[idx + 3] = alpha;
      }
    }
  }

  return nativeImage.createFromBuffer(buf, { width: w, height: h, scaleFactor: scale });
}

function buildContextMenu(): Menu {
  const statusLabel = daemonReachable ? 'Daemon running' : 'Daemon stopped';
  const dotIcon = createDotIcon(daemonReachable ? '#34c759' : '#8e8e93', daemonReachable);

  return Menu.buildFromTemplate([
    { label: statusLabel, enabled: false, icon: dotIcon },
    { type: 'separator' },
    { label: 'Projects', click: () => showWindow('projects') },
    { label: 'MCP Clients', click: () => showWindow('clients') },
    { label: 'Settings', click: () => showWindow('settings') },
    { type: 'separator' },
    {
      label: 'Quit trace-mcp',
      click: () => {
        cleanup();
        app.quit();
      },
    },
  ]);
}

function setTrayIcon(reachable: boolean): void {
  const icons = getTrayIconPaths();
  const img = nativeImage.createFromPath(reachable ? icons.active : icons.inactive);
  if (isMac) {
    img.setTemplateImage(true);
  }
  tray.setImage(img);
  tray.setToolTip(reachable ? 'trace-mcp — running' : 'trace-mcp — daemon unreachable');
}

function shouldAttemptRestart(failureTick: number): boolean {
  if (RESTART_ATTEMPT_TICKS.has(failureTick)) return true;
  const last = Math.max(...RESTART_ATTEMPT_TICKS);
  if (failureTick <= last) return false;
  return (failureTick - last) % RESTART_RETRY_EVERY === 0;
}

async function checkHealth(): Promise<void> {
  try {
    const health = await daemon.health();
    if (!daemonReachable || consecutiveFailures > 0) {
      console.log('[trace-mcp] daemon reachable');
    }
    daemonReachable = true;
    consecutiveFailures = 0;
    _lastRestartAttempt = 0;
    setTrayIcon(true);

    // Version mismatch — npm swapped the binary on disk but the running daemon
    // is still executing the old code from memory. Restart via launchd so the
    // freshly-installed version takes over. 60s cooldown prevents a loop if
    // the new daemon also reports the wrong version for any reason.
    const daemonVersion = health.version?.replace(/^v/, '');
    const appVersion = app.getVersion().replace(/^v/, '');
    if (
      daemonVersion &&
      daemonVersion !== '0.0.0-dev' &&
      daemonVersion !== appVersion &&
      Date.now() - lastVersionMismatchRestart > VERSION_MISMATCH_RESTART_COOLDOWN_MS
    ) {
      lastVersionMismatchRestart = Date.now();
      console.log(
        `[trace-mcp] version mismatch — daemon=${daemonVersion} app=${appVersion}, restarting daemon`,
      );
      try {
        const result = restartDaemon();
        if (!result.ok) {
          console.warn(`[trace-mcp] version-mismatch restart failed: ${result.error ?? 'unknown'}`);
        }
      } catch (e) {
        console.warn(`[trace-mcp] version-mismatch restart threw: ${(e as Error).message}`);
      }
    }
  } catch (err) {
    // HTTP 429 means the daemon is alive and responding, just rate-limiting
    // this client. Restarting would not help — repeated restarts on a
    // healthy-but-throttled daemon produced a visible flap cycle in the
    // past (an old daemon without the localhost rate-limit exemption would
    // 429 the tray's polling, which was then read as "dead"). Treat as
    // reachable.
    if (err instanceof Error && err.message.startsWith('HTTP 429')) {
      if (!daemonReachable || consecutiveFailures > 0) {
        console.log('[trace-mcp] daemon reachable (throttled)');
      }
      daemonReachable = true;
      consecutiveFailures = 0;
      _lastRestartAttempt = 0;
      setTrayIcon(true);
      tray.setContextMenu(buildContextMenu());
      return;
    }

    daemonReachable = false;
    consecutiveFailures++;
    setTrayIcon(false);

    if (shouldAttemptRestart(consecutiveFailures)) {
      // First failure → try a soft start (noop if already running, stale PID, etc.).
      // Later failures → force restart (kills any zombie then starts fresh).
      const useRestart = consecutiveFailures > 1;
      const action = useRestart ? 'restart' : 'ensure';
      _lastRestartAttempt = consecutiveFailures;
      console.log(
        `[trace-mcp] daemon unreachable (fail #${consecutiveFailures}), attempting ${action}`,
      );
      try {
        const result = useRestart ? restartDaemon() : ensureDaemon();
        if (!result.ok) {
          console.warn(`[trace-mcp] daemon ${action} failed: ${result.error ?? 'unknown'}`);
        }
      } catch (e) {
        console.warn(`[trace-mcp] daemon ${action} threw: ${(e as Error).message}`);
      }
    }
  }
  // Rebuild menu to reflect status change
  tray.setContextMenu(buildContextMenu());
}

// Handle native "+" button in tab bar — macOS only
if (isMac) {
  app.on('new-window-for-tab', () => {
    if (menuWindow && !menuWindow.isDestroyed()) {
      menuWindow.focus();
    } else {
      showMenuWindow();
    }
  });
}

export function createTray(): Tray {
  const icons = getTrayIconPaths();
  const icon = nativeImage.createFromPath(icons.inactive);
  if (isMac) {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);
  tray.setContextMenu(buildContextMenu());

  // On Windows, clicks on tray icon open the window (standard behavior).
  // Single click shows window, double-click also (Windows convention).
  if (!isMac) {
    tray.on('click', () => {
      showWindow();
    });
    tray.on('double-click', () => {
      showWindow();
    });
  }

  // Initial health check + periodic polling
  checkHealth();
  healthInterval = setInterval(checkHealth, 5_000);

  // Update title bar color + tray icon when system theme changes
  nativeTheme.on('updated', () => {
    const color = getTitleBarColor();
    const allWindows = [menuWindow, ...projectWindows.values()];
    for (const win of allWindows) {
      if (win && !win.isDestroyed()) {
        win.setBackgroundColor(color);
      }
    }
    // On Windows, tray icon color needs to match the taskbar theme
    if (!isMac) {
      setTrayIcon(daemonReachable);
    }
  });

  return tray;
}

function cleanup(): void {
  if (healthInterval) clearInterval(healthInterval);
}
