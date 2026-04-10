import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-folder'),
  openInEditor: (filePath: string): Promise<void> => ipcRenderer.invoke('open-in-editor', filePath),
  restartDaemon: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('restart-daemon'),
});
