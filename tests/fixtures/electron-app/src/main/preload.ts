import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-folder'),
  openFile: (filePath: string): Promise<void> => ipcRenderer.invoke('open-file', filePath),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  getConfigSync: (): unknown => ipcRenderer.sendSync('get-config-sync'),
  logEvent: (message: string): void => ipcRenderer.send('log-event', message),
  onUpdateAvailable: (callback: (info: unknown) => void) => {
    ipcRenderer.on('update-available', (_event, info) => callback(info));
  },
  onDownloadProgress: (callback: (percent: number) => void) => {
    ipcRenderer.once('download-progress', (_event, percent) => callback(percent));
  },
  onDataResponse: (callback: (data: unknown) => void) => {
    ipcRenderer.on('data-response', (_event, data) => callback(data));
  },
});
