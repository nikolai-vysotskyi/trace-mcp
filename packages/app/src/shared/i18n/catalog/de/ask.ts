export const ask = {
  title: 'Fragen',

  noProviderTitle: 'KI-Anbieter verbinden',
  noProviderSubtitle:
    'Fragen beantwortet Fragen zu diesem Projekt mit einem Modell, das du bereitstellst. Füge in den Einstellungen eines hinzu, um die Funktion zu aktivieren.',
  openAiSettings: 'KI-Einstellungen öffnen',

  chats: 'Chats',
  newChat: 'Neuer Chat',
  noChats: 'Noch keine Chats.',
  untitled: 'Ohne Titel',
  deleteChat: 'Chat löschen (⌫)',
  connectingProvider: 'Verbindung wird hergestellt…',
  noProvider: 'Kein Anbieter',

  showContextPanel: 'Kontextbereich einblenden',
  hideContextPanel: 'Kontextbereich ausblenden',
  showContext: 'Kontext einblenden',
  hideContext: 'Kontext ausblenden',
  loadingChat: 'Chat wird geladen',
  conversation: 'Unterhaltung',

  emptyTitle: 'Frag alles über diese Codebasis',
  emptySubtitle:
    'Die Antworten stützen sich auf den indexierten Graph — die Dateien, Symbole und Entscheidungen, die dieses Projekt bereits hat.',
  slashCommands: 'Slash-Befehle',
  slashFind: 'Symbole nach Namen suchen',
  slashImpact: 'Änderungsauswirkung für ein Symbol anzeigen',
  slashScan: 'Sicherheitsscan ausführen (wichtigste OWASP-Funde)',
  suggestionAuth: 'Wie funktioniert die Authentifizierung?',
  suggestionPlugins: 'Erkläre das Plugin-System',
  suggestionRoutes: 'Wo liegen die API-Routen?',

  retrieving: 'Codebasis wird durchsucht',
  thinking: 'Denkt nach',
  sendAgain: 'Erneut senden',

  composerLabel: 'Frage zu diesem Projekt',
  composerPlaceholder: 'Frag etwas zu diesem Projekt oder tippe / für Befehle',
  stopGenerating: 'Generierung stoppen',
  sendMessage: 'Nachricht senden',
  sendShortcut: 'Senden (⌘↵)',
  copyCode: 'Code kopieren',
  copied: 'Kopiert',

  context: 'Kontext',
  noContextTitle: 'Noch kein Kontext',
  noContextSubtitle:
    'Die Dateien, Symbole und Entscheidungen, die das Modell gelesen hat, erscheinen hier, nachdem du eine Nachricht gesendet hast. Slash-Befehle rufen keinen Kontext ab.',
  filesRead: 'Gelesene Dateien',
  noFilesRead: 'Es wurden keine Dateien gelesen.',
  symbolsRead: 'Gelesene Symbole',
  decisionsConsulted: 'Herangezogene Entscheidungen',

  loadSessionFailed: 'Sitzung konnte nicht geladen werden',
  createSessionFailed: 'Sitzung konnte nicht erstellt werden',
  noSession: 'Es konnte keine Chat-Sitzung aufgebaut werden',
  slashFailed: 'Slash-Befehl fehlgeschlagen',
  unknownError: 'Unbekannter Fehler',
} as const;
