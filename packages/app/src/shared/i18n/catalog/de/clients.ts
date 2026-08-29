export const clients = {
  title: 'MCP-Clients',
  refresh: 'Clients aktualisieren',

  supported: 'Unterstützte Clients',
  sessions: 'Aktive Sitzungen',
  detecting: 'Clients werden erkannt',
  loadingSessions: 'Sitzungen werden geladen',

  daemonDownTitle: 'Daemon nicht erreichbar',
  daemonDownSubtitle:
    'trace-mcp-Clients verbinden sich über den lokalen Daemon. Starte ihn, um sie zu sehen und einzurichten.',
  startDaemon: 'Daemon starten',
  starting: 'Wird gestartet…',

  noSessionsTitle: 'Keine aktiven Sitzungen',
  noSessionsSubtitle: 'Eine Sitzung erscheint hier, sobald sich ein Client mit dem Daemon verbindet.',
  unnamedSession: 'Unbenannte Sitzung',

  sessionActive: 'Aktiv',
  sessionIdle: 'Inaktiv',
  sessionStale: 'Veraltet',

  connected: 'Verbunden',
  connect: 'Verbinden',
  connecting: 'Verbindung wird hergestellt…',
  updateAvailable: 'Update verfügbar',
  update: 'Aktualisieren',
  updating: 'Wird aktualisiert…',
  driftedField: 'Abweichendes Feld: {{field}}',
  setUpManually: 'Manuell einrichten…',
  hideSteps: 'Schritte ausblenden',

  enforcementLevel: 'Durchsetzungsgrad',
  levelBase: 'Basis',
  levelBaseHint: 'Nur CLAUDE.md — weiche Routing-Regeln',
  levelStandard: 'Standard',
  levelStandardHint: 'CLAUDE.md und Hooks',
  levelMax: 'Maximal',
  levelMaxHint: 'CLAUDE.md, Hooks und tweakcc — empfohlen',
} as const;
