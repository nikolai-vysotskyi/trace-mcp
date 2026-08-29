import path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Tray } from 'electron';
import { TRAFFIC_LIGHT_X, TRAFFIC_LIGHT_Y, trafficLightYFor } from '../shared/chrome-metrics.js';
import { parseWindowMode, shouldRunAsAccessory } from '../shared/window-mode.js';
import { DaemonClient } from './api-client';
import {
  type Appearance,
  parseAppearance,
  readAppearance,
  themeSourceFor,
  writeAppearance,
} from './appearance';
import { ensureDaemon, restartDaemon } from './daemon-lifecycle';
import { t } from './i18n';

const isMac = process.platform === 'darwin';

/**
 * Render the app without ever putting a window on screen (TRA-403).
 *
 * Agent harnesses drive this app on a machine somebody is using: macOS follows
 * an app activation to the Space that app's window lives on, so a review run
 * that shows a window drags the user out of their full-screen app. With
 * `TRACE_MCP_WINDOW_MODE=hidden` the window is created, loads and paints, but is
 * never mapped — no Dock icon, no activation, nothing on screen — and a CDP
 * screenshot of it is a real, current frame (measured: `Page.captureScreenshot`
 * on an unmapped window returns the same pixels as on a visible one).
 *
 * Set by `scripts/electron-cdp.mjs`. `TRACE_MCP_AGENT_RUN=1` is the same
 * request from the other direction — "nobody is looking at this run" — and is
 * what an agent launching the app some other way sets. Never set in a shipped
 * build; a human running `pnpm dev` has neither and sees today's behaviour.
 */
export const HIDDEN_WINDOWS =
  process.env.TRACE_MCP_WINDOW_MODE === 'hidden' || process.env.TRACE_MCP_AGENT_RUN === '1';

/**
 * Run as a background process with no Dock icon and no ⌘-Tab entry.
 *
 * Every unpackaged build defaults to this, not just the hidden-window capture
 * runs: an agent that starts `electron .` by hand hits the same activation, and
 * a rule that only holds when somebody remembers a flag is not a rule. A shipped
 * build is unaffected — it is a real app and keeps its Dock icon. Pass
 * `TRACE_MCP_WINDOW_MODE=visible` (or `electron-cdp.mjs --visible`) to opt a dev
 * run back into being a normal foreground app.
 *
 * A hidden-window run is always accessory, packaged or not: a capture against
 * the shipped artifact must not activate it either.
 */
export const ACCESSORY_APP =
  HIDDEN_WINDOWS ||
  shouldRunAsAccessory(parseWindowMode(process.env.TRACE_MCP_WINDOW_MODE), app.isPackaged);

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
/**
 * Timestamp of the last time we asked launchd / lifecycle.ts to ensure or
 * restart the daemon. Used to grant a freshly-spawned daemon a grace window
 * during which a missed /health poll does NOT count as a failure. Without
 * this, a slow startup (post-update migrations, FK recovery, cold reindex
 * of many registered projects) can block the daemon's event loop past the
 * 5s health timeout for a few polls — three misses trigger `daemon restart`,
 * which kills the in-progress startup, and the next daemon repeats the
 * same slow startup → infinite restart loop. 60s covers typical cold-start
 * cost on a developer machine with O(30) registered projects.
 */
let lastDaemonStartAttempt = 0;
const DAEMON_STARTUP_GRACE_MS = 60_000;

const daemon = new DaemonClient();

function getRendererUrl(params?: Record<string, string>): string {
  const base = `file://${path.join(__dirname, '..', 'renderer', 'index.html')}`;
  if (!params || Object.keys(params).length === 0) return base;
  const qs = new URLSearchParams(params).toString();
  return `${base}?${qs}`;
}

function createWindowOptions(
  extraOpts?: Partial<Electron.BrowserWindowConstructorOptions>,
): Electron.BrowserWindowConstructorOptions {
  const opts: Electron.BrowserWindowConstructorOptions = {
    width: 960,
    height: 700,
    minWidth: 640,
    minHeight: 420,
    show: false,
    icon: APP_ICON,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: false,
    // Non-mac keeps an opaque backing (only ever visible for the frame before
    // the renderer's first paint); macOS gets the NSVisualEffectView below.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    ...extraOpts,
  };
  if (isMac) {
    // tabbingIdentifier is macOS-only
    opts.tabbingIdentifier = TABBING_ID;
    // Native NSVisualEffectView behind the whole window. The renderer paints
    // the content pane opaque and leaves the sidebar region transparent, so
    // only the sidebar reads as vibrant. `visualEffectState: 'followWindow'`
    // desaturates it when the window loses key, and macOS honours Reduce
    // Transparency for free — no CSS backdrop-filter fallback needed.
    opts.titleBarStyle = 'hiddenInset';
    // Derived from the band height in src/shared/chrome-metrics.ts — the same
    // number `--top-band-h` is generated from. Never write the offset by hand:
    // that is what put the lights 3px below the sidebar toggle (TRA-370).
    opts.trafficLightPosition = { x: TRAFFIC_LIGHT_X, y: TRAFFIC_LIGHT_Y };
    opts.vibrancy = 'sidebar';
    opts.visualEffectState = 'followWindow';
    opts.backgroundColor = '#00000000';
    opts.transparent = false;
  }
  /* Dev-only, set by `scripts/electron-cdp.mjs launch`. Chromium stops
     compositing a fully occluded window, and a CDP screenshot of one returns
     the last frame it painted — so a design review run behind another app
     silently captures stale pixels. Keeping the harness window on top is what
     makes the capture honest. Never set in a shipped build. */
  if (process.env.TRACE_MCP_DEV_ALWAYS_ON_TOP === '1') opts.alwaysOnTop = true;
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

  /* Every event that can change how many tabs the group holds, or that gives a
     renderer that missed the last broadcast a chance to catch up. 'closed' is
     the one the bug was reported against; 'focus' also covers a tab dragged out
     into its own window, which fires nothing else we can see. */
  win.on('show', syncTabChromeSoon);
  win.on('focus', syncTabChromeSoon);
  win.on('closed', syncTabChromeSoon);
  win.webContents.on('did-finish-load', syncTabChrome);

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

/** Put a loaded window on screen — the one place that shows and focuses one. */
function presentWindow(win: BrowserWindow): void {
  if (HIDDEN_WINDOWS) return;
  ensureDockVisible();
  win.show();
  win.focus();
}

/* ---- The native tab bar (macOS), and the two things it breaks (TRA-399) ----

   Every window we open carries the same `tabbingIdentifier`, so a second window
   is a second TAB, and AppKit answers with a tab bar. Two consequences, both of
   which have to be re-derived whenever the tab count crosses 1:

   1. The tab bar is painted over the top of the web contents (the window is
      full-size content view, so the viewport never shrinks). The renderer has
      to reserve MAC_TAB_BAR_H or the tab bar covers its whole top band — the
      Files/Symbols control, Filter, Search, Fit, Live, ··· and the sidebar
      toggle, all of them, unreachable. `tabbar-changed` is that signal.

   2. The traffic lights are ours to place, and the band they belong to changes:
      44px while we own the top line, 36px (the tab bar) while AppKit does.
      `trafficLightPosition` is applied once at window creation, and AppKit
      re-lays the title bar out when the tab bar comes and goes — so the custom
      offset has to be re-applied, or the lights keep an offset measured against
      a band that is no longer there until something else forces a layout pass.
      A window resize was the "fix" users found. */

/** Is AppKit drawing a tab bar? True exactly when the group holds >1 tab. */
function tabBarVisible(): boolean {
  return isMac && BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length > 1;
}

/**
 * Re-derive both, for every window, from the tab count that holds right now.
 * Idempotent and cheap, so it can be called from anything that might have
 * changed the answer rather than only from the one path we thought of.
 */
function syncTabChrome(): void {
  if (!isMac) return;
  const visible = tabBarVisible();
  const y = trafficLightYFor(visible);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.setWindowButtonPosition({ x: TRAFFIC_LIGHT_X, y });
    } catch {
      /* window torn down between the guard and the call */
    }
    safeSend(win, 'tabbar-changed', visible);
  }
}

/**
 * The same, once the run loop has caught up. AppKit adds and removes the tab
 * bar asynchronously around 'closed' and 'ready-to-show', so a position written
 * synchronously can be measured against the title bar we are leaving rather
 * than the one we are arriving at. Running it twice costs nothing and removes
 * the race — never rely on the synchronous pass alone.
 */
function syncTabChromeSoon(): void {
  if (!isMac) return;
  syncTabChrome();
  setTimeout(syncTabChrome, 120);
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
      title: t('tray:menuWindow'),
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
      presentWindow(menuWindow);
    }
  } else {
    const win = projectWindows.get(tabId);
    if (win && !win.isDestroyed()) {
      presentWindow(win);
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

// IPC: open the menu window on the MCP clients tab
ipcMain.handle('open-clients', () => {
  showMenuWindow('clients');
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
    presentWindow(menuWindow);
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
    menuWindow?.setTitle(t('tray:menuWindow'));
  });

  menuWindow.once('ready-to-show', () => {
    if (menuWindow) presentWindow(menuWindow);
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
    if (!HIDDEN_WINDOWS) existing.focus();
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
    presentWindow(win);
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

/* ---- Appearance → the native layer (TRA-369) ------------------------------
   macOS only. On Windows `nativeTheme.shouldUseDarkColors` also picks the tray
   icon, which has to match the TASKBAR — i.e. the system — not the app's own
   Appearance choice, and there is no way to read the system value back once
   themeSource overrides it. macOS is where this matters anyway: it is the only
   platform with an NSVisualEffectView to keep in sync, and its tray icon is a
   Template image the system tints on its own. */

/** Call once from whenReady, BEFORE the first window: `backgroundColor` is read
 *  from `nativeTheme` at construction time. */
export function restoreAppearance(): void {
  if (!isMac) return;
  nativeTheme.themeSource = themeSourceFor(readAppearance(app.getPath('userData')));
}

function applyAppearance(next: Appearance): void {
  if (!isMac) return;
  nativeTheme.themeSource = themeSourceFor(next);
  writeAppearance(app.getPath('userData'), next);
}

// IPC: the renderer's Appearance choice. Fire-and-forget — the renderer has
// already applied [data-theme] itself and does not wait on the native side.
ipcMain.on('set-appearance', (_event, value: unknown) => {
  applyAppearance(parseAppearance(value));
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
  const statusLabel = daemonReachable ? t('tray:daemonRunning') : t('tray:daemonStopped');
  const dotIcon = createDotIcon(daemonReachable ? '#34c759' : '#8e8e93', daemonReachable);

  return Menu.buildFromTemplate([
    { label: statusLabel, enabled: false, icon: dotIcon },
    { type: 'separator' },
    { label: t('tray:workspace'), click: () => showWindow('workspace') },
    { label: t('tray:clients'), click: () => showWindow('clients') },
    { label: t('tray:settings'), click: () => showWindow('settings') },
    { type: 'separator' },
    {
      label: t('tray:quit'),
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
  tray.setToolTip(reachable ? t('tray:tooltipRunning') : t('tray:tooltipStopped'));
}

/** Redraw everything the tray shows in words, after a language change. The IPC
    that triggers it lives in menu.ts — this file is imported BY that one, and
    importing back would close a cycle. No-op before `createTray`. */
export function refreshTrayMenu(): void {
  if (!tray || tray.isDestroyed()) return;
  setTrayIcon(daemonReachable);
  tray.setContextMenu(buildContextMenu());
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.setTitle(t('tray:menuWindow'));
  broadcastTabList();
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
        lastDaemonStartAttempt = Date.now();
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
    setTrayIcon(false);

    // Grace period after a recent ensure/restart: a freshly spawned daemon
    // may be busy with post-update migrations, FK recovery, or a cold reindex
    // of many registered projects. Counting these misses as failures and
    // shooting it with `daemon restart` restarts the same slow startup from
    // zero — an infinite loop. Hold the counter steady until the grace
    // window elapses; once expired, normal failure accounting resumes.
    const sinceLastStart = Date.now() - lastDaemonStartAttempt;
    if (lastDaemonStartAttempt > 0 && sinceLastStart < DAEMON_STARTUP_GRACE_MS) {
      tray.setContextMenu(buildContextMenu());
      return;
    }

    consecutiveFailures++;

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
        lastDaemonStartAttempt = Date.now();
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
      presentWindow(menuWindow);
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

  // On Windows, tray icon color needs to match the taskbar theme. macOS window
  // chrome needs no repaint — the vibrancy view follows the system appearance.
  if (!isMac) {
    nativeTheme.on('updated', () => {
      setTrayIcon(daemonReachable);
    });
  }

  return tray;
}

function cleanup(): void {
  if (healthInterval) clearInterval(healthInterval);
}
