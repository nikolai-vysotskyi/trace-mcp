export const update = {
  staleRoots: 'MCP-Clients laufen weiterhin auf v{{version}}',
  staleRootsTitle:
    'Deine Editoren starten trace-mcp aus {{pkgDir}}, dort liegt v{{version}}. Diese Kopie wurde von einem anderen npm installiert, das Update dieser App hat sie also nicht berührt — bis sie aktualisiert ist, nutzt jeder MCP-Client weiter den alten Server.\n\nIm Terminal aktualisieren:\n{{command}}',
  copyStaleRootCommand: 'Update-Befehl kopieren',

  duplicateApps: 'Mehrfach installiert',
  duplicateApp: '{{path}} · v{{version}}',
  duplicateAppRunning: '{{path}} · v{{version}} — läuft gerade',
  duplicateAppsTitle:
    'Auf diesem Mac liegt mehr als eine Kopie von trace-mcp:\n\n{{list}}\n\nNur die Kopie, die du öffnest, wird aktualisiert — welche du als Nächstes startest, entscheidet also über deine Version. Behalte die Kopie, die du nutzt, und verschiebe die andere in den Papierkorb — oder öffne die andere einmal und lass sie sich selbst aktualisieren.',
  revealDuplicateApp: 'Andere Kopie im Finder zeigen',

  // ── The app menu's header (AppMenu.tsx) ─────────────────────────────────
  headerVersion: 'Version {{version}}',
  headerChecking: 'Wird geprüft…',
  headerAvailable: 'Version {{version}} verfügbar',
  headerUpToDate: 'Aktuell · geprüft {{when}}',

  // ── The update card in the sidebar (App.tsx) ────────────────────────────
  cardReadyTitle: 'v{{version}} bereit',
  cardReadySubtitle: 'Zum Installieren neu starten · v{{current}}',
  cardRestart: 'Zum Installieren neu starten',
  cardAvailableTitle: 'v{{version}} verfügbar',
  cardAvailableSubtitle: 'Aktuell v{{current}} · geprüft {{when}}',
  cardUpdate: 'Aktualisieren',
  cardUpdating: 'Wird aktualisiert…',
} as const;
