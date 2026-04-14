import path from 'path';
import { Tray, nativeImage, Menu, BrowserWindow, app, shell, ipcMain, dialog, nativeTheme } from 'electron';
import { DaemonClient } from './api-client';
import { ensureDaemon } from './daemon-lifecycle';

const ICON_ACTIVE = path.join(__dirname, '..', '..', 'assets', 'tray-iconTemplate.png');
const ICON_INACTIVE = path.join(__dirname, '..', '..', 'assets', 'tray-icon-dimTemplate.png');
const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

const TABBING_ID = 'trace-mcp-tabs';

let tray: Tray;
let menuWindow: BrowserWindow | null = null;
const projectWindows = new Map<string, BrowserWindow>(); // root → window
let healthInterval: ReturnType<typeof setInterval>;
let daemonReachable = false;
let daemonStartAttempted = false;

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

function createWindowOptions(extraOpts?: Partial<Electron.BrowserWindowConstructorOptions>): Electron.BrowserWindowConstructorOptions {
  return {
    width: 960,
    height: 700,
    show: false,
    icon: APP_ICON,
    tabbingIdentifier: TABBING_ID,
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
}

function setupWindowEvents(win: BrowserWindow): void {
  win.on('enter-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('fullscreen-changed', true);
  });
  win.on('leave-full-screen', () => {
    if (!win.isDestroyed()) win.webContents.send('fullscreen-changed', false);
  });

  // Auto-reload on renderer crash (GPU crash, OOM, etc.)
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[trace-mcp] renderer crashed in window: reason=${details.reason}`);
    if (!win.isDestroyed() && details.reason !== 'clean-exit') {
      // Delay slightly to let GPU process restart
      setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reload();
      }, 1000);
    }
  });

  // Handle unresponsive renderer
  win.on('unresponsive', () => {
    console.warn('[trace-mcp] window became unresponsive, reloading...');
    if (!win.isDestroyed()) win.webContents.reload();
  });
}

function ensureDockVisible(): void {
  app.dock?.show();
  app.dock?.setIcon(nativeImage.createFromPath(APP_ICON));
}

/** Notify ALL windows whether the native tab bar is visible */
function broadcastTabBar(visible: boolean): void {
  const allWindows = [menuWindow, ...projectWindows.values()];
  for (const win of allWindows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('tabbar-changed', visible);
    }
  }
}

function hideDockIfNoWindows(): void {
  if (!menuWindow && projectWindows.size === 0) {
    app.dock?.hide();
  }
}

function showMenuWindow(tab?: string): void {
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

  // Attach to existing tab group if project windows are open
  const existingTab = [...projectWindows.values()].find(w => !w.isDestroyed());
  if (existingTab) {
    existingTab.addTabbedWindow(menuWindow);
  }

  menuWindow.webContents.on('did-finish-load', () => {
    menuWindow?.setTitle('Menu');
  });

  menuWindow.once('ready-to-show', () => {
    ensureDockVisible();
    menuWindow?.show();
    menuWindow?.focus();
  });

  setupWindowEvents(menuWindow);

  menuWindow.on('closed', () => {
    menuWindow = null;
    hideDockIfNoWindows();
  });
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
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.addTabbedWindow(win);
  }

  win.once('ready-to-show', () => {
    ensureDockVisible();
    win.show();
    win.focus();
    // First project tab opened → tab bar is now visible
    broadcastTabBar(true);
  });

  setupWindowEvents(win);

  // Set tab title to project name (after page load so HTML <title> doesn't override)
  const projectName = root.split('/').filter(Boolean).pop() || root;
  win.webContents.on('did-finish-load', () => {
    win.setTitle(projectName);
  });

  win.on('closed', () => {
    projectWindows.delete(root);
    // If no more project tabs, tab bar disappears (only menu window left)
    if (projectWindows.size === 0) {
      broadcastTabBar(false);
    }
    hideDockIfNoWindows();
  });
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
    if (win && !win.isDestroyed() && win.webContents !== sender) {
      win.webContents.send('sidebar-width-changed', width);
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
  const w = (r + glowR) * 2;  // tight width — no extra left padding
  const h = 16 * scale;       // full menu item height
  const cx = r + glowR;       // circle flush to left edge
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
        // Soft glow falloff — mimics boxShadow: 0 0 4px
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
    { label: 'Quit trace-mcp', click: () => { cleanup(); app.quit(); } },
  ]);
}

function setTrayIcon(reachable: boolean): void {
  const iconPath = reachable ? ICON_ACTIVE : ICON_INACTIVE;
  const img = nativeImage.createFromPath(iconPath);
  img.setTemplateImage(true);
  tray.setImage(img);
  tray.setToolTip(reachable ? 'trace-mcp — running' : 'trace-mcp — daemon unreachable');
}

async function checkHealth(): Promise<void> {
  try {
    await daemon.health();
    daemonReachable = true;
    daemonStartAttempted = false; // reset so we can retry if it goes down later
    setTrayIcon(true);
  } catch {
    // Try to auto-start daemon once when it's unreachable
    if (!daemonStartAttempted) {
      daemonStartAttempted = true;
      try {
        ensureDaemon();
      } catch { /* best effort */ }
    }
    daemonReachable = false;
    setTrayIcon(false);
  }
  // Rebuild menu to reflect status change
  tray.setContextMenu(buildContextMenu());
}

// Handle native "+" button in tab bar — focus Menu tab
app.on('new-window-for-tab', () => {
  if (menuWindow && !menuWindow.isDestroyed()) {
    menuWindow.focus();
  } else {
    showMenuWindow();
  }
});

export function createTray(): Tray {
  const icon = nativeImage.createFromPath(ICON_INACTIVE);
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setContextMenu(buildContextMenu());

  // Initial health check + periodic polling
  checkHealth();
  healthInterval = setInterval(checkHealth, 5_000);

  // Update title bar color when system theme changes
  nativeTheme.on('updated', () => {
    const color = getTitleBarColor();
    const allWindows = [menuWindow, ...projectWindows.values()];
    for (const win of allWindows) {
      if (win && !win.isDestroyed()) {
        win.setBackgroundColor(color);
      }
    }
  });

  return tray;
}

function cleanup(): void {
  if (healthInterval) clearInterval(healthInterval);
}
