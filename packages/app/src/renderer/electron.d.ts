export {};

declare global {
  interface Window {
    electronAPI?: {
      selectFolder: () => Promise<string | null>;
      openInEditor: (filePath: string) => Promise<void>;
      openExternal: (url: string) => Promise<{ ok: boolean; error?: string }>;
      detectIdeApps: () => Promise<{ id: string; name: string; bundlePath: string }[]>;
      openInIde: (bundlePath: string, filePath: string) => Promise<{ ok: boolean; error?: string }>;
      restartDaemon: () => Promise<{ ok: boolean }>;
      detectMcpClients: () => Promise<{ name: string; configPath: string; hasTraceMcp: boolean }[]>;
      getMcpClientStatuses: (
        scope?: 'global' | 'project',
      ) => Promise<{
        ok: boolean;
        error?: string;
        statuses?: Array<{
          client: string;
          configPath: string | null;
          status: 'missing' | 'up_to_date' | 'stale' | 'unmanageable' | 'unknown';
          staleReason?: string;
        }>;
      }>;
      configureMcpClient: (
        clientName: string,
        level: string,
      ) => Promise<{ ok: boolean; error?: string }>;
      openProjectTab: (root: string) => Promise<{ ok: boolean }>;
      closeCurrentTab: () => Promise<{ ok: boolean }>;
      onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => () => void;
      onTabBarChanged: (callback: (visible: boolean) => void) => () => void;
      syncSidebarWidth: (width: number) => void;
      onSidebarWidthChanged: (callback: (width: number) => void) => () => void;
      checkForUpdate: () => Promise<{
        available: boolean;
        current?: string;
        latest?: string;
        lastChecked?: number;
        error?: string;
      }>;
      checkPendingUpdate: () => Promise<{ pending: boolean; version?: string }>;
      applyUpdate: () => Promise<{ ok: boolean; pending?: boolean; error?: string }>;
      restartApp: () => Promise<void>;
      openSettings: (section?: string) => Promise<{ ok: boolean }>;
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
          reason?: string;
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
