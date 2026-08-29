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

  // ── The app menu's header (AppMenu.tsx) ─────────────────────────────────
  headerVersion: 'Version {{version}}',
  headerChecking: 'Checking…',
  headerAvailable: 'Version {{version}} available',
  headerManualInstall: 'Version {{version}} needs a manual install',
  /** `when` is a relative time from i18n/format.ts, e.g. "2 hr. ago". */
  headerUpToDate: 'Up to date · checked {{when}}',

  // ── The update card in the sidebar (App.tsx) ────────────────────────────
  cardReadyTitle: 'v{{version}} ready',
  cardReadySubtitle: 'Restart to install · v{{current}}',
  cardRestart: 'Restart to install',
  cardStuckTitle: 'v{{version}} needs a manual install',
  cardStuckSubtitle:
    'The command line tool updated, but the app itself is still v{{current}} — it could not replace its own bundle. Download the release and drag it into Applications.',
  cardDownload: 'Download v{{version}}',
  cardAvailableTitle: 'v{{version}} available',
  cardAvailableSubtitle: 'Currently v{{current}} · checked {{when}}',
  cardUpdate: 'Update',
  cardUpdating: 'Updating…',
} as const;
