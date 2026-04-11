import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-folder'),
  openInEditor: (filePath: string): Promise<void> => ipcRenderer.invoke('open-in-editor', filePath),
  restartDaemon: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('restart-daemon'),
  detectMcpClients: (): Promise<{ name: string; configPath: string; hasTraceMcp: boolean }[]> =>
    ipcRenderer.invoke('detect-mcp-clients'),
  configureMcpClient: (clientName: string, level: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('configure-mcp-client', clientName, level),
  openProjectTab: (root: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('open-project-tab', root),
  closeCurrentTab: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('close-current-tab'),
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) => callback(isFullscreen);
    ipcRenderer.on('fullscreen-changed', handler);
    return () => { ipcRenderer.removeListener('fullscreen-changed', handler); };
  },
  onTabBarChanged: (callback: (visible: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
    ipcRenderer.on('tabbar-changed', handler);
    return () => { ipcRenderer.removeListener('tabbar-changed', handler); };
  },
  syncSidebarWidth: (width: number): void => {
    ipcRenderer.send('sync-sidebar-width', width);
  },
  onSidebarWidthChanged: (callback: (width: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, width: number) => callback(width);
    ipcRenderer.on('sidebar-width-changed', handler);
    return () => { ipcRenderer.removeListener('sidebar-width-changed', handler); };
  },
});
