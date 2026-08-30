export const update = {
  staleRoots: 'MCP-Clients laufen weiterhin auf v{{version}}',
  staleRootsTitle:
    'Deine Editoren starten trace-mcp aus {{pkgDir}}, dort liegt v{{version}}. Diese Kopie wurde von einem anderen npm installiert, das Update dieser App hat sie also nicht berührt — bis sie aktualisiert ist, nutzt jeder MCP-Client weiter den alten Server.\n\nIm Terminal aktualisieren:\n{{command}}',
  copyStaleRootCommand: 'Update-Befehl kopieren',

  // ── The app menu's header (AppMenu.tsx) ─────────────────────────────────
  headerVersion: 'Version {{version}}',
  headerChecking: 'Wird geprüft…',
  headerAvailable: 'Version {{version}} verfügbar',
  headerManualInstall: 'Version {{version}} muss manuell installiert werden',
  headerUpToDate: 'Aktuell · geprüft {{when}}',

  // ── The update card in the sidebar (App.tsx) ────────────────────────────
  cardReadyTitle: 'v{{version}} bereit',
  cardReadySubtitle: 'Zum Installieren neu starten · v{{current}}',
  cardRestart: 'Zum Installieren neu starten',
  cardStuckTitle: 'v{{version}} muss manuell installiert werden',
  cardStuckSubtitle:
    'Das Kommandozeilenwerkzeug wurde aktualisiert, die App selbst ist aber weiterhin v{{current}} — sie konnte ihr eigenes Bundle nicht ersetzen. Lade das Release herunter und ziehe es in den Programme-Ordner.',
  cardDownload: 'v{{version}} laden',
  cardStuckQuarantine:
    'macOS wird den Download als beschädigt bezeichnen. Er ist es nicht — führe dies einmal aus, nachdem du ihn in den Programme-Ordner verschoben hast:',
  copyQuarantineCommand: 'Befehl kopieren',
  cardAvailableTitle: 'v{{version}} verfügbar',
  cardAvailableSubtitle: 'Aktuell v{{current}} · geprüft {{when}}',
  cardUpdate: 'Aktualisieren',
  cardUpdating: 'Wird aktualisiert…',
} as const;
