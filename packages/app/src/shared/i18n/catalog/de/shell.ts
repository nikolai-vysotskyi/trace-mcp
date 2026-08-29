export const shell = {
  // ── Sections ────────────────────────────────────────────────────────────
  navWorkspace: 'Workspace',
  navClients: 'MCP-Clients',
  navOverview: 'Übersicht',
  navAsk: 'Fragen',
  navGraph: 'Graph',
  navActivity: 'Aktivität',
  navMemory: 'Wissen',
  navNotebook: 'Notebook',
  navInsights: 'Insights',

  // ── Sidebar chrome ──────────────────────────────────────────────────────
  sidebar: 'Seitenleiste',
  sections: 'Bereiche',
  showSidebar: 'Seitenleiste einblenden',
  hideSidebar: 'Seitenleiste ausblenden',
  showSidebarTitle: 'Seitenleiste einblenden (⌘⌥S)',
  hideSidebarTitle: 'Seitenleiste ausblenden (⌘⌥S)',
  resizeSidebar: 'Breite der Seitenleiste ändern',
  appMenu: 'App-Menü',
  theme: 'Erscheinungsbild',
  language: 'Sprache',
  themeAuto: 'Automatisch',
  themeLight: 'Hell',
  themeDark: 'Dunkel',
  app: 'App',

  // ── Recent projects ─────────────────────────────────────────────────────
  recent: 'Zuletzt benutzt',
  noProjectsOpened: 'Noch keine Projekte geöffnet.',
  openAProject: 'Projekt öffnen…',
  openProject: 'Projekt öffnen',
  copyPath: 'Pfad kopieren',
  removeFromRecent: 'Aus „Zuletzt benutzt“ entfernen',
  removeFromRecentTitle: 'Aus „Zuletzt benutzt“ entfernen (⌫)',

  // ── File explorer ───────────────────────────────────────────────────────
  files: 'Dateien',
  projectFiles: 'Projektdateien',
  sortFilesBy: 'Dateien sortieren nach',
  sortMostSymbols: 'Meiste Symbole',
  sortMostConnected: 'Stärkste Vernetzung',
  sortDeadCode: 'Toter Code',
  sortRecentlyChanged: 'Zuletzt geändert',
  loadingFiles: 'Dateien werden geladen',
  noFilesMatchScope: 'Keine indexierten Dateien in diesem Bereich.',
  fileTitle: '{{path}} — Symbole: {{symbols}}, Kanten: {{edges}}',
  revealInGraph: 'Im Graph anzeigen',
  openInEditor: 'Im Editor öffnen',

  // ── Quick open ──────────────────────────────────────────────────────────
  quickOpen: 'Schnell öffnen',
  quickOpenPlaceholder: 'Zu Bereich, Projekt oder Datei springen',
  quickOpenResults: 'Ergebnisse',
  quickOpenNoMatches: 'Keine Treffer',
  quickOpenGroupGoTo: 'Gehe zu',
  quickOpenGroupRecent: 'Zuletzt benutzte Projekte',
  quickOpenGroupFiles: 'Dateien',

  // ── Window tab strip (Windows / Linux) ──────────────────────────────────
  menuWindow: 'Menü',
  closeTab: '{{title}} schließen',

  // ── Error boundary ──────────────────────────────────────────────────────
  tabLabel: 'Tab „{{tab}}“',
  crashed: '{{label}} ist abgestürzt',
  somethingWentWrong: 'Etwas ist schiefgelaufen',
  tryAgain: 'Erneut versuchen',
} as const;
