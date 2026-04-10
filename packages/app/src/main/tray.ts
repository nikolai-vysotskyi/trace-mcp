import path from 'path';
import { Tray, nativeImage, Menu, BrowserWindow, app, shell, ipcMain, dialog } from 'electron';
import { DaemonClient } from './api-client';

const ICON_ACTIVE = path.join(__dirname, '..', '..', 'assets', 'tray-iconTemplate.png');
const ICON_INACTIVE = path.join(__dirname, '..', '..', 'assets', 'tray-icon-dimTemplate.png');
const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

let tray: Tray;
let mainWindow: BrowserWindow | null = null;
let healthInterval: ReturnType<typeof setInterval>;
let daemonReachable = false;

const daemon = new DaemonClient();

function getRendererUrl(tab?: string): string {
  const base = `file://${path.join(__dirname, '..', 'renderer', 'index.html')}`;
  return tab ? `${base}?tab=${tab}` : base;
}

function showWindow(tab?: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (tab) {
      mainWindow.loadURL(getRendererUrl(tab));
    }
    app.dock?.setIcon(nativeImage.createFromPath(APP_ICON));
    app.dock?.show();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 480,
    height: 560,
    show: false,
    icon: APP_ICON,
    frame: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    transparent: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(getRendererUrl(tab));

  mainWindow.once('ready-to-show', () => {
    app.dock?.setIcon(nativeImage.createFromPath(APP_ICON));
    app.dock?.show();
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.dock?.hide();
  });
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
    { label: 'Indexes', click: () => showWindow('indexes') },
    { label: 'Clients', click: () => showWindow('clients') },
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
    setTrayIcon(true);
  } catch {
    daemonReachable = false;
    setTrayIcon(false);
  }
  // Rebuild menu to reflect status change
  tray.setContextMenu(buildContextMenu());
}

export function createTray(): Tray {
  const icon = nativeImage.createFromPath(ICON_INACTIVE);
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setContextMenu(buildContextMenu());

  // Initial health check + periodic polling
  checkHealth();
  healthInterval = setInterval(checkHealth, 5_000);

  return tray;
}

function cleanup(): void {
  if (healthInterval) clearInterval(healthInterval);
}
