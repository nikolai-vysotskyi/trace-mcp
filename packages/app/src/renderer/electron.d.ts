export {};

/** Mirror of `DaemonSetupState` in main/daemon-install.ts. The renderer is
    compiled separately from Electron main, so the shape is restated rather
    than imported across that boundary. */
type DaemonSetupState =
  | { phase: 'idle' }
  | { phase: 'installing' }
  | { phase: 'ready' }
  | { phase: 'failed'; message: string };

declare global {
  interface Window {
    /** Window chrome facts from the main process. Undefined in a browser. */
    electronChrome?: {
      /** The window is `titleBarStyle: 'hiddenInset'` — leave room for the
       *  real traffic lights. Never infer this from `navigator.userAgent`. */
      insetTitleBar: boolean;
    };
    electronAPI?: {
      selectFolder: () => Promise<string | null>;
      openInEditor: (filePath: string) => Promise<void>;
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
      /** Reveal a path in Finder — never opens it (TRA-692). */
      showInFolder?: (target: string) => Promise<{ ok: boolean; error?: string }>;
      detectIdeApps: () => Promise<{ id: string; name: string; bundlePath: string }[]>;
      openInIde: (bundlePath: string, filePath: string) => Promise<{ ok: boolean; error?: string }>;
      restartDaemon: () => Promise<{ ok: boolean }>;
      /** TRA-525: OS-level daemon liveness, independent of /health. */
      daemonProcessAlive?: () => Promise<boolean>;
      /** TRA-438: progress of the app's own daemon install. */
      daemonSetupState?: () => Promise<DaemonSetupState>;
      retryDaemonSetup?: () => Promise<DaemonSetupState>;
      onDaemonSetupState?: (cb: (state: DaemonSetupState) => void) => () => void;
      detectMcpClients: () => Promise<{ name: string; configPath: string; hasTraceMcp: boolean }[]>;
      guessFirstProject: () => Promise<{ path: string; name: string } | null>;
      getMcpClientStatuses: (
        scope?: 'global' | 'project',
      ) => Promise<{
        ok: boolean;
        error?: string;
        statuses?: Array<{
          client: string;
          configPath: string | null;
          status: 'missing' | 'up_to_date' | 'stale' | 'legacy' | 'unmanageable' | 'unknown';
          staleReason?: string;
          level?: 'base' | 'standard' | 'max' | null;
        }>;
      }>;
      configureMcpClient: (
        clientName: string,
        level: string,
      ) => Promise<{ ok: boolean; error?: string }>;
      /** Repair drifted entries. Setup asks for an enforcement level; this never does. */
      updateMcpClients: (clientNames: string[]) => Promise<{ ok: boolean; error?: string }>;
      openProjectTab: (root: string) => Promise<{ ok: boolean }>;
      closeCurrentTab: () => Promise<{ ok: boolean }>;
      onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => () => void;
      setAppearance: (appearance: 'auto' | 'light' | 'dark') => void;
      setLocale: (locale: string) => void;
      syncSidebarWidth: (width: number) => void;
      onSidebarWidthChanged: (callback: (width: number) => void) => () => void;
      checkForUpdate: () => Promise<{
        available: boolean;
        current?: string;
        latest?: string;
        lastChecked?: number;
        error?: string;
        /** Global npm roots holding an older trace-mcp than the newest install on this machine. */
        staleRoots?: { root: string; version: string }[];
        /** Installed `.app` bundles when this machine holds more than one (TRA-692). */
        duplicateApps?: { path: string; version: string; running: boolean }[];
      }>;
      /** `percent` is only present while a download is still in flight. */
      checkPendingUpdate: () => Promise<{ pending: boolean; version?: string; percent?: number }>;
      applyUpdate: () => Promise<{
        ok: boolean;
        pending?: boolean;
        error?: string;
        version?: string;
        /** Global npm roots holding an older trace-mcp than the newest install on this machine. */
        staleRoots?: { root: string; version: string }[];
      }>;
      /** electron-updater's `download-progress`, forwarded verbatim. */
      onUpdateProgress: (
        callback: (p: {
          percent: number;
          bytesPerSecond: number;
          transferred: number;
          total: number;
        }) => void,
      ) => () => void;
      restartApp: () => Promise<void>;
      openSettings: (section?: string) => Promise<{ ok: boolean }>;
      openClients: () => Promise<{ ok: boolean }>;
      // Application menu ↔ renderer (TRA-297)
      setWindowSections: (sections: { id: string; label: string }[]) => void;
      onAppCommand: (callback: (command: string, arg?: unknown) => void) => () => void;
      // Tab management (Windows custom tab bar)
      getPlatform: () => Promise<string>;
      focusTab: (tabId: string) => Promise<{ ok: boolean }>;
      onTabListChanged: (
        callback: (tabs: { id: string; title: string; type: string; active: boolean }[]) => void,
      ) => () => void;
      guard: {
        status: (projectRoot: string) => Promise<{
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
        }>;
        initialize: (projectRoot: string) => Promise<{
          initialized: boolean;
          mode?: 'strict' | 'coach' | 'off';
          error?: string;
        }>;
        checkCliVersion: () => Promise<{
          current: string | null;
          required: string;
          ok: boolean;
          needsUpgrade: boolean;
          notInstalled: boolean;
          reason?: string;
        }>;
        installStatus: () => Promise<{
          claudeDetected: boolean;
          installed: boolean;
          scriptPath?: string;
          reason?: string;
        }>;
        install: () => Promise<{
          ok: boolean;
          alreadyInstalled?: boolean;
          backupPath?: string;
          scriptPath?: string;
          error?: string;
        }>;
        uninstall: () => Promise<{
          ok: boolean;
          removed?: boolean;
          backupPath?: string;
          error?: string;
        }>;
        setMode: (
          projectRoot: string,
          mode: 'strict' | 'coach' | 'off',
        ) => Promise<{ ok: boolean; error?: string }>;
        setBypass: (
          projectRoot: string,
          minutes: number,
        ) => Promise<{ ok: boolean; error?: string }>;
      };
      ollama: {
        status: (
          baseUrl?: string,
        ) => Promise<{ running: boolean; version?: string; baseUrl: string; error?: string }>;
        listInstalled: (baseUrl?: string) => Promise<{ models: OllamaInstalledModel[] }>;
        listRunning: (baseUrl?: string) => Promise<{ models: OllamaRunningModel[] }>;
        unload: (name: string, baseUrl?: string) => Promise<{ ok: boolean; error?: string }>;
        delete: (name: string, baseUrl?: string) => Promise<{ ok: boolean; error?: string }>;
        start: (baseUrl?: string) => Promise<{ ok: boolean; method?: string; error?: string }>;
        stop: (baseUrl?: string) => Promise<{ ok: boolean; method?: string; error?: string }>;
      };
    };
  }

  interface OllamaInstalledModel {
    name: string;
    size: number;
    modified_at?: string;
    digest?: string;
    details?: { parameter_size?: string; quantization_level?: string; family?: string };
  }

  interface OllamaRunningModel {
    name: string;
    size: number;
    size_vram: number;
    expires_at?: string;
    digest?: string;
    details?: { parameter_size?: string; quantization_level?: string; family?: string };
  }
}
