import { app, ipcMain, dialog, shell, nativeImage } from 'electron';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createTray } from './tray';

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Hide dock icon — this is a tray app (dock shown when window opens)
app.dock?.hide();

const dockIconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');

// IPC: folder picker
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select project root',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// IPC: open file in default editor
ipcMain.handle('open-in-editor', async (_event, filePath: string) => {
  await shell.openPath(filePath);
});

// IPC: restart daemon (kill old, start new via launchd)
ipcMain.handle('restart-daemon', async () => {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.trace-mcp.server.plist');

  // Unload existing plist if loaded
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
  } catch { /* not loaded — fine */ }

  // If plist doesn't exist, we can't restart — need daemon start first
  if (!fs.existsSync(plistPath)) {
    throw new Error('Daemon plist not found. Run "trace-mcp daemon start" once to set it up.');
  }

  execSync(`launchctl load "${plistPath}"`);
  return { ok: true };
});

app.whenReady().then(() => {
  // Set custom dock icon (must be after app ready)
  if (fs.existsSync(dockIconPath)) {
    app.dock?.setIcon(nativeImage.createFromPath(dockIconPath));
  }
  createTray();
});

app.on('window-all-closed', () => {
  // Keep running in tray even if all windows are closed
});
