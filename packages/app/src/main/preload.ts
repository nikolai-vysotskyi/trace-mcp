import { contextBridge, ipcRenderer } from 'electron';
import type { DaemonSetupState } from './daemon-install';

/* Window chrome the renderer has to lay out around, answered synchronously
   because it gates first paint. `titleBarStyle: 'hiddenInset'` is set for
   darwin in main/tray.ts, so the same condition decides it here. Absent in a
   plain browser — which is the point: `navigator.userAgent` says "Mac" there
   too, and keying the traffic-light reservation off it drew a 44px strip in
   `vite dev` that the real window never has. */
contextBridge.exposeInMainWorld('electronChrome', {
  insetTitleBar: process.platform === 'darwin',
});

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-folder'),
  openInEditor: (filePath: string): Promise<void> => ipcRenderer.invoke('open-in-editor', filePath),
  openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('open-external', url),
  detectIdeApps: (): Promise<{ id: string; name: string; bundlePath: string }[]> =>
    ipcRenderer.invoke('detect-ide-apps'),
  openInIde: (bundlePath: string, filePath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('open-in-ide', bundlePath, filePath),
  restartDaemon: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('restart-daemon'),
  /** TRA-525: OS-level daemon liveness, so "busy" can be told from "not running". */
  daemonProcessAlive: (): Promise<boolean> => ipcRenderer.invoke('daemon:process-alive'),
  /* TRA-438: the app installs its own daemon on first launch. Until that
     finishes there is no daemon to be down, so the surfaces say "Setting up…"
     instead of offering a Start button for something not installed yet. */
  daemonSetupState: (): Promise<DaemonSetupState> => ipcRenderer.invoke('daemon:setup-state'),
  retryDaemonSetup: (): Promise<DaemonSetupState> => ipcRenderer.invoke('daemon:setup-retry'),
  onDaemonSetupState: (cb: (state: DaemonSetupState) => void): (() => void) => {
    const handler = (_e: unknown, state: DaemonSetupState) => cb(state);
    ipcRenderer.on('daemon:setup-state', handler);
    return () => ipcRenderer.removeListener('daemon:setup-state', handler);
  },
  detectMcpClients: (): Promise<{ name: string; configPath: string; hasTraceMcp: boolean }[]> =>
    ipcRenderer.invoke('detect-mcp-clients'),
  getMcpClientStatuses: (
    scope?: 'global' | 'project',
  ): Promise<{
    ok: boolean;
    error?: string;
    statuses?: Array<{
      client: string;
      configPath: string | null;
      status: 'missing' | 'up_to_date' | 'stale' | 'unmanageable' | 'unknown';
      staleReason?: string;
      level?: 'base' | 'standard' | 'max' | null;
    }>;
  }> => ipcRenderer.invoke('get-mcp-client-statuses', scope ?? 'global'),
  configureMcpClient: (
    clientName: string,
    level: string,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('configure-mcp-client', clientName, level),
  /** Repair drifted entries. Setup asks for an enforcement level; this never does. */
  updateMcpClients: (clientNames: string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('update-mcp-clients', clientNames),
  openProjectTab: (root: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('open-project-tab', root),
  closeCurrentTab: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('close-current-tab'),
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) =>
      callback(isFullscreen);
    ipcRenderer.on('fullscreen-changed', handler);
    return () => {
      ipcRenderer.removeListener('fullscreen-changed', handler);
    };
  },
  onTabBarChanged: (callback: (visible: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, visible: boolean) => callback(visible);
    ipcRenderer.on('tabbar-changed', handler);
    return () => {
      ipcRenderer.removeListener('tabbar-changed', handler);
    };
  },
  /** Mirror the renderer's appearance choice onto `nativeTheme`, so the
      sidebar's native vibrancy matches the theme the DOM is painting. */
  setAppearance: (appearance: 'auto' | 'light' | 'dark'): void => {
    ipcRenderer.send('set-appearance', appearance);
  },
  /** Mirror the renderer's language choice into the main process, which draws
      the application menu and the tray and cannot read localStorage. */
  setLocale: (locale: string): void => {
    ipcRenderer.send('set-locale', locale);
  },
  syncSidebarWidth: (width: number): void => {
    ipcRenderer.send('sync-sidebar-width', width);
  },
  onSidebarWidthChanged: (callback: (width: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, width: number) => callback(width);
    ipcRenderer.on('sidebar-width-changed', handler);
    return () => {
      ipcRenderer.removeListener('sidebar-width-changed', handler);
    };
  },
  checkForUpdate: (): Promise<{
    available: boolean;
    current?: string;
    latest?: string;
    lastChecked?: number;
    error?: string;
    /** True when the user already attempted this transition via npm-only and nothing on disk has moved since. */
    stuck?: boolean;
    /** Global npm roots holding an older trace-mcp than the newest install on this machine. */
    staleRoots?: { root: string; version: string }[];
    /** Absolute path to the running `.app`, so copyable commands name the real install. */
    installPath?: string;
  }> => ipcRenderer.invoke('check-for-update'),
  checkPendingUpdate: (): Promise<{ pending: boolean; version?: string }> =>
    ipcRenderer.invoke('check-pending-update'),
  applyUpdate: (): Promise<{
    ok: boolean;
    pending?: boolean;
    error?: string;
    /** "bundle-pending" — restart will swap the .app; "npm-only" — CLI moved but bundle is stuck; "already-current" — nothing to do. */
    outcome?: 'bundle-pending' | 'npm-only' | 'already-current';
    version?: string;
    /** Global npm roots holding an older trace-mcp than the newest install on this machine. */
    staleRoots?: { root: string; version: string }[];
  }> => ipcRenderer.invoke('apply-update'),
  restartApp: (): Promise<void> => ipcRenderer.invoke('restart-app'),
  openSettings: (section?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('open-settings', section),
  /* Client setup lives in the menu window; the Activity feed that tells you
     nothing is connected lives in a project window. Without this verb its
     empty state had no action to offer (TRA-294). */
  openClients: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('open-clients'),
  /* Application menu ↔ renderer (TRA-297). The menu owns the accelerator; the
     renderer owns what the command means on the surface in front of the user.
     `setWindowSections` reports this window's ⌘1…⌘9 destinations so the View
     menu can name them instead of duplicating the list in the main process. */
  setWindowSections: (sections: { id: string; label: string }[]): void => {
    ipcRenderer.send('window-sections', sections);
  },
  onAppCommand: (callback: (command: string, arg?: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: string, arg?: unknown) =>
      callback(command, arg);
    ipcRenderer.on('app-command', handler);
    return () => {
      ipcRenderer.removeListener('app-command', handler);
    };
  },
  // Tab management (Windows custom tab bar)
  getPlatform: (): Promise<string> => ipcRenderer.invoke('get-platform'),
  focusTab: (tabId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('focus-tab', tabId),
  onTabListChanged: (
    callback: (tabs: { id: string; title: string; type: string; active: boolean }[]) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      tabs: { id: string; title: string; type: string; active: boolean }[],
    ) => callback(tabs);
    ipcRenderer.on('tab-list-changed', handler);
    return () => {
      ipcRenderer.removeListener('tab-list-changed', handler);
    };
  },
  // trace-mcp guard control: read project status + toggle per-project mode.
  // Mode persists in <projectRoot>/.trace-mcp/guard-mode; status JSON is
  // refreshed by the trace-mcp server every ~5s.
  guard: {
    status: (
      projectRoot: string,
    ): Promise<{
      health: 'ok' | 'stalled' | 'down' | 'unknown';
      mode: 'strict' | 'coach' | 'off';
      pid?: number;
      lastSuccessAt?: string | null;
      toolCallsTotal?: number;
      toolCallsFailed?: number;
      quietSeconds?: number;
      bypassUntil?: number;
      reason?: string;
      initializedAt?: number;
      coachExpiresAt?: number;
      autoPromoted?: boolean;
    }> => ipcRenderer.invoke('guard:status', projectRoot),
    initialize: (
      projectRoot: string,
    ): Promise<{ initialized: boolean; mode?: 'strict' | 'coach' | 'off'; error?: string }> =>
      ipcRenderer.invoke('guard:initialize', projectRoot),
    checkCliVersion: (): Promise<{
      current: string | null;
      required: string;
      ok: boolean;
      needsUpgrade: boolean;
      notInstalled: boolean;
      reason?: string;
    }> => ipcRenderer.invoke('guard:check-cli-version'),
    installStatus: (): Promise<{
      claudeDetected: boolean;
      installed: boolean;
      scriptPath?: string;
      reason?: string;
    }> => ipcRenderer.invoke('guard:install-status'),
    install: (): Promise<{
      ok: boolean;
      alreadyInstalled?: boolean;
      backupPath?: string;
      scriptPath?: string;
      error?: string;
    }> => ipcRenderer.invoke('guard:install'),
    uninstall: (): Promise<{
      ok: boolean;
      removed?: boolean;
      backupPath?: string;
      error?: string;
    }> => ipcRenderer.invoke('guard:uninstall'),
    setMode: (
      projectRoot: string,
      mode: 'strict' | 'coach' | 'off',
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('guard:set-mode', projectRoot, mode),
    setBypass: (
      projectRoot: string,
      minutes: number,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('guard:set-bypass', projectRoot, minutes),
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
