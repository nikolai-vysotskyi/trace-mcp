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
  showInFolder: (target: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('show-in-folder', target),
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
  guessFirstProject: (): Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke('guess-first-project'),
  getMcpClientStatuses: (
    scope?: 'global' | 'project',
  ): Promise<{
    ok: boolean;
    error?: string;
    statuses?: Array<{
      client: string;
      configPath: string | null;
      status: 'missing' | 'up_to_date' | 'stale' | 'legacy' | 'unmanageable' | 'unknown';
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
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isFullscreen: boolean) =>
      callback(isFullscreen);
    ipcRenderer.on('fullscreen-changed', handler);
    return () => {
      ipcRenderer.removeListener('fullscreen-changed', handler);
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
    /** Global npm roots holding an older trace-mcp than the newest install on this machine. */
    staleRoots?: { root: string; version: string }[];
    /** Installed `.app` bundles when this machine holds more than one (TRA-692). */
    duplicateApps?: { path: string; version: string; running: boolean }[];
  }> => ipcRenderer.invoke('check-for-update'),
  /** `percent` is only present while a download is still in flight. */
  checkPendingUpdate: (): Promise<{ pending: boolean; version?: string; percent?: number }> =>
    ipcRenderer.invoke('check-pending-update'),
  applyUpdate: (): Promise<{
    ok: boolean;
    pending?: boolean;
    error?: string;
    version?: string;
    /** Global npm roots holding an older trace-mcp than the newest install on this machine. */
    staleRoots?: { root: string; version: string }[];
  }> => ipcRenderer.invoke('apply-update'),
  /* The daemon's own version, checked and updated independently of the app
     bundle above — the two can drift apart in either direction (TRA-686). */
  checkForDaemonUpdate: (): Promise<{
    available: boolean;
    current?: string;
    latest?: string;
    lastChecked?: number;
    error?: string;
  }> => ipcRenderer.invoke('check-for-daemon-update'),
  applyDaemonUpdate: (): Promise<{
    ok: boolean;
    version?: string;
    error?: string;
    /** Present when the install could not run automatically — a command to copy and run by hand. */
    command?: string;
  }> => ipcRenderer.invoke('apply-daemon-update'),
  /* electron-updater's own `download-progress`, forwarded verbatim. The
     download runs for minutes on a slow link, so the card needs a real number
     rather than an indeterminate bar that cannot distinguish slow from hung. */
  onUpdateProgress: (
    callback: (p: {
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      p: { percent: number; bytesPerSecond: number; transferred: number; total: number },
    ) => callback(p);
    ipcRenderer.on('update-progress', handler);
    return () => {
      ipcRenderer.removeListener('update-progress', handler);
    };
  },
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
  // Tab bar: the renderer owns the tab list (App.tsx); main only pushes
  // lifecycle events for it to fold in (TRA-700).
  getPlatform: (): Promise<string> => ipcRenderer.invoke('get-platform'),
  onOpenTab: (callback: (payload: { root: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { root: string }) =>
      callback(payload);
    ipcRenderer.on('open-tab', handler);
    return () => {
      ipcRenderer.removeListener('open-tab', handler);
    };
  },
  onNewTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('new-tab', handler);
    return () => {
      ipcRenderer.removeListener('new-tab', handler);
    };
  },
  onFocusTab: (callback: (tabId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tabId: string) => callback(tabId);
    ipcRenderer.on('focus-tab', handler);
    return () => {
      ipcRenderer.removeListener('focus-tab', handler);
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
      reason?: 'heartbeat_stale' | 'channel_quiet' | 'never_started';
      reasonSeconds?: number;
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
