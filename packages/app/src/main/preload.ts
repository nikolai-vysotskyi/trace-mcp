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
  checkForUpdate: (): Promise<{ available: boolean; current?: string; latest?: string; lastChecked?: number; error?: string }> =>
    ipcRenderer.invoke('check-for-update'),
  checkPendingUpdate: (): Promise<{ pending: boolean; version?: string }> =>
    ipcRenderer.invoke('check-pending-update'),
  applyUpdate: (): Promise<{ ok: boolean; pending?: boolean; error?: string }> =>
    ipcRenderer.invoke('apply-update'),
  restartApp: (): Promise<void> =>
    ipcRenderer.invoke('restart-app'),
  openSettings: (section?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('open-settings', section),
  // Tab management (Windows custom tab bar)
  getPlatform: (): Promise<string> =>
    ipcRenderer.invoke('get-platform'),
  focusTab: (tabId: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('focus-tab', tabId),
  onTabListChanged: (callback: (tabs: { id: string; title: string; type: string; active: boolean }[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tabs: { id: string; title: string; type: string; active: boolean }[]) => callback(tabs);
    ipcRenderer.on('tab-list-changed', handler);
    return () => { ipcRenderer.removeListener('tab-list-changed', handler); };
  },
  // Ollama control: passes baseUrl through so the renderer stays authoritative about
  // which Ollama instance we're talking to (users can repoint in settings).
  ollama: {
    status: (baseUrl?: string) => ipcRenderer.invoke('ollama:status', baseUrl),
    listInstalled: (baseUrl?: string) => ipcRenderer.invoke('ollama:list-installed', baseUrl),
    listRunning: (baseUrl?: string) => ipcRenderer.invoke('ollama:list-running', baseUrl),
    unload: (name: string, baseUrl?: string) => ipcRenderer.invoke('ollama:unload', name, baseUrl),
    delete: (name: string, baseUrl?: string) => ipcRenderer.invoke('ollama:delete', name, baseUrl),
    start: (baseUrl?: string) => ipcRenderer.invoke('ollama:start', baseUrl),
    stop: (baseUrl?: string) => ipcRenderer.invoke('ollama:stop', baseUrl),
  },
});
