export {};

declare global {
  interface Window {
    electronAPI?: {
      selectFolder: () => Promise<string | null>;
      openInEditor: (filePath: string) => Promise<void>;
      restartDaemon: () => Promise<{ ok: boolean }>;
      detectMcpClients: () => Promise<{ name: string; configPath: string; hasTraceMcp: boolean }[]>;
      configureMcpClient: (clientName: string, level: string) => Promise<{ ok: boolean; error?: string }>;
      openProjectTab: (root: string) => Promise<{ ok: boolean }>;
      closeCurrentTab: () => Promise<{ ok: boolean }>;
      onFullscreenChanged: (callback: (isFullscreen: boolean) => void) => () => void;
      onTabBarChanged: (callback: (visible: boolean) => void) => () => void;
      syncSidebarWidth: (width: number) => void;
      onSidebarWidthChanged: (callback: (width: number) => void) => () => void;
      checkForUpdate: () => Promise<{ available: boolean; current?: string; latest?: string; error?: string }>;
      applyUpdate: () => Promise<{ ok: boolean; error?: string }>;
      restartApp: () => Promise<void>;
      // Tab management (Windows custom tab bar)
      getPlatform: () => Promise<string>;
      focusTab: (tabId: string) => Promise<{ ok: boolean }>;
      onTabListChanged: (callback: (tabs: { id: string; title: string; type: string; active: boolean }[]) => void) => () => void;
    };
  }
}
