/* Update state: the app menu header, the update card and the stale-root
   warning. */

export const update = {
  /* Singular, not a plural key: the main process sends at most one stale root —
     the one MCP clients actually launch from — so there is no count to inflect
     (TRA-377). The line names the consequence rather than the filesystem fact,
     and the title carries the install and the one command that ends it. */
  staleRoots: 'MCP clients still run v{{version}}',
  staleRootsTitle:
    'Your editors launch trace-mcp from {{pkgDir}}, which is on v{{version}}. That copy was installed by a different npm, so updating this app did not touch it — until it is updated, every MCP client keeps using the old server.\n\nUpdate it from a terminal:\n{{command}}',
  copyStaleRootCommand: 'Copy update command',

  /* Two installed copies of the app. No count in the line: three copies is the
     same sentence, and no plural forms to keep in ten catalogues (TRA-692). The
     line states the condition rather than blaming a copy — neither is the wrong
     one, and the title hands back the choice instead of an instruction. */
  duplicateApps: 'Installed more than once',
  duplicateApp: '{{path}} · v{{version}}',
  duplicateAppRunning: '{{path}} · v{{version}} — running now',
  duplicateAppsTitle:
    'This Mac holds more than one copy of trace-mcp:\n\n{{list}}\n\nOnly the copy you open gets updated, so whichever one you launch next decides the version you get. Keep the copy you use and move the other to the Trash — or open the other one once and let it update itself.',
  revealDuplicateApp: 'Show the other copy in Finder',

  // ── The app menu's header (AppMenu.tsx) ─────────────────────────────────
  headerVersion: 'Version {{version}}',
  headerChecking: 'Checking…',
  headerAvailable: 'Version {{version}} available',
  /** `when` is a relative time from i18n/format.ts, e.g. "2 hr. ago". */
  headerUpToDate: 'Up to date · checked {{when}}',
  /** One button checks both the app and the daemon (TRA-686); these two name
      whichever one the plain `headerAvailable` line above cannot, because more
      than the app itself is behind. */
  headerDaemonAvailable: 'Daemon update available · v{{version}}',
  headerBothAvailable: 'App and daemon updates available',

  // ── The update card in the sidebar (App.tsx) ────────────────────────────
  cardReadyTitle: 'v{{version}} ready',
  cardReadySubtitle: 'Restart to install · v{{current}}',
  cardRestart: 'Restart to install',
  cardAvailableTitle: 'v{{version}} available',
  cardAvailableSubtitle: 'Currently v{{current}} · checked {{when}}',
  cardUpdate: 'Update',
  cardUpdating: 'Updating…',

  // ── Settings → Updates (Settings.tsx, TRA-686) ──────────────────────────
  settingsTitle: 'Updates',
  settingsAppRow: 'App',
  settingsDaemonRow: 'Daemon',
  settingsCheck: 'Check for updates',
} as const;
