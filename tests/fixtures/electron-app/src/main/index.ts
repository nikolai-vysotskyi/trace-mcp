import { app, ipcMain, BrowserWindow, Tray, nativeImage, Menu, protocol } from 'electron';
import path from 'path';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile('src/renderer/index.html');

  tray = new Tray(nativeImage.createEmpty());

  const menu = Menu.buildFromTemplate([
    { label: 'Quit', click: () => app.quit() },
  ]);
  Menu.setApplicationMenu(menu);

  // Custom protocol
  protocol.handle('app', (request) => {
    return new Response('OK');
  });
});

// IPC handlers
ipcMain.handle('select-folder', async () => {
  return '/mock/path';
});

ipcMain.handleOnce('get-initial-config', async () => {
  return { theme: 'dark' };
});

ipcMain.handle('open-file', async (_event, filePath: string) => {
  console.log('Opening:', filePath);
});

ipcMain.handle('get-app-version', async () => {
  return app.getVersion();
});

ipcMain.on('log-event', (_event, message: string) => {
  console.log('[renderer]', message);
});

ipcMain.once('init-complete', () => {
  console.log('Renderer initialized');
});

// Reply pattern
ipcMain.on('request-data', (event) => {
  event.sender.send('data-response', { items: [] });
});

// Push to renderer
function notifyRendererUpdate(data: unknown) {
  if (mainWindow) {
    mainWindow.webContents.send('update-available', data);
    mainWindow.webContents.send('download-progress', 50);
  }
}
