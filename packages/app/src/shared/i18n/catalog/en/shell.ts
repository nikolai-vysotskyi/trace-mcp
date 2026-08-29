/* The window itself: the sidebar and its sections, the recent-projects and
   file lists, quick open, the Windows tab strip and the error boundary.

   Section names are also what the native application menu shows — App.tsx
   publishes this list to the main process — so they are one set of keys, not
   one for the sidebar and another for the menu. */

export const shell = {
  // ── Sections ────────────────────────────────────────────────────────────
  navWorkspace: 'Workspace',
  navClients: 'MCP Clients',
  navOverview: 'Overview',
  navAsk: 'Ask',
  navGraph: 'Graph',
  navActivity: 'Activity',
  navMemory: 'Memory',
  navNotebook: 'Notebook',
  navInsights: 'Insights',

  // ── Sidebar chrome ──────────────────────────────────────────────────────
  sidebar: 'Sidebar',
  sections: 'Sections',
  showSidebar: 'Show sidebar',
  hideSidebar: 'Hide sidebar',
  showSidebarTitle: 'Show sidebar (⌘⌥S)',
  hideSidebarTitle: 'Hide sidebar (⌘⌥S)',
  resizeSidebar: 'Resize sidebar',
  appMenu: 'App menu',
  theme: 'Theme',
  themeAuto: 'Auto',
  themeLight: 'Light',
  themeDark: 'Dark',
  /** The whole-window error boundary's name for what crashed. */
  app: 'App',

  // ── Recent projects ─────────────────────────────────────────────────────
  recent: 'Recent',
  noProjectsOpened: 'No projects opened yet.',
  openAProject: 'Open a project…',
  openProject: 'Open project',
  copyPath: 'Copy path',
  removeFromRecent: 'Remove from recent',
  removeFromRecentTitle: 'Remove from recent (⌫)',

  // ── File explorer ───────────────────────────────────────────────────────
  files: 'Files',
  projectFiles: 'Project files',
  sortFilesBy: 'Sort files by',
  sortMostSymbols: 'Most Symbols',
  sortMostConnected: 'Most Connected',
  sortDeadCode: 'Dead Code',
  sortRecentlyChanged: 'Recently Changed',
  loadingFiles: 'Loading files',
  noFilesMatchScope: 'No indexed files match this scope.',
  /* Two counts in one line, so neither can be an i18next plural — the
     languages that need one say "symbols: 12" instead. */
  fileTitle: '{{path}} — {{symbols}} symbols, {{edges}} edges',
  revealInGraph: 'Reveal in graph',
  openInEditor: 'Open in editor',

  // ── Quick open ──────────────────────────────────────────────────────────
  quickOpen: 'Quick open',
  quickOpenPlaceholder: 'Go to section, project or file',
  quickOpenResults: 'Results',
  quickOpenNoMatches: 'No matches',
  quickOpenGroupGoTo: 'Go to',
  quickOpenGroupRecent: 'Recent projects',
  quickOpenGroupFiles: 'Files',

  // ── Window tab strip (Windows / Linux) ──────────────────────────────────
  menuWindow: 'Menu',
  closeTab: 'Close {{title}}',

  // ── Error boundary ──────────────────────────────────────────────────────
  tabLabel: '{{tab}} tab',
  crashed: '{{label}} crashed',
  somethingWentWrong: 'Something went wrong',
  tryAgain: 'Try again',
} as const;
