export const insights = {
  title: 'Insights',
  reportPicker: 'Bericht',
  run: 'Ausführen',
  refresh: 'Aktualisieren',
  running: 'Läuft…',
  runAction: '{{report}} {{action}}',
  unknownError: 'Unbekannter Fehler',
  errorInit: 'Es konnte keine Sitzung mit dem Daemon gestartet werden (HTTP {{status}}).',
  errorNoSession: 'Der Daemon hat eine Sitzung gestartet, sie aber nicht benannt.',
  errorHttp: 'Die Berichtsanfrage ist fehlgeschlagen (HTTP {{status}}). {{detail}}',
  errorToolFailed: 'Der Bericht wurde nicht ausgeführt.',

  reportDriftTitle: 'CLAUDE.md-Abweichungen',
  reportDriftDescription: 'Veraltete Pfade und tote Symbolverweise in Agenten-Konfigurationsdateien.',
  reportPagerankTitle: 'Zentralste Dateien',
  reportPagerankDescription:
    'Architektonisch zentralste Dateien nach PageRank auf dem Import-Graph.',
  reportRiskTitle: 'Risiko-Hotspots',
  reportRiskDescription: 'Dateien mit hoher Komplexität und hoher Git-Änderungsrate.',

  runningDrift: 'Agenten-Konfiguration wird mit dem Index abgeglichen…',
  runningPagerank: 'Dateien werden nach Import-Zentralität sortiert…',
  runningRisk: 'Komplexität wird mit der Git-Änderungsrate korreliert…',

  emptyTitle: 'Nichts zu berichten',
  emptyBody: 'Dieser Bericht kam leer zurück — derzeit passt nichts im Projekt dazu.',

  // ── Row text produced by the flatteners ──
  noDescription: '(keine Beschreibung)',
  rowIssue: '{{location}} — {{issue}}',
  rowFix: 'Behebung: {{fix}}',
  rowScore: 'Score {{score}}',
  rowHotspot: 'Komplexität {{complexity}} · {{commits}} Commits',
  rowHotspotConfidence: 'Komplexität {{complexity}} · {{commits}} Commits · {{confidence}}',

  reportStartupTitle: 'Startkontext',
  reportStartupDescription:
    'Wofür jede Sitzung schon vor deiner ersten Nachricht bezahlt, was das kostet und wodurch es doppelt bezahlt wird. Aus den Sitzungsprotokollen auf diesem Mac gelesen; nichts wird irgendwohin gesendet.',
  runningStartup: 'Der Startblock wird in den Sitzungsprotokollen vermessen…',

  startupBlockRow: 'Startblock — {{tokens}} Tokens',
  startupBlockDetail: 'Median · p10 {{p10}} · p90 {{p90}} · {{sessions}} Sitzungen in {{days}} Tagen',
  startupCostRow: 'Kosten des Startblocks — {{usd}}',
  startupCostDetail: 'von {{total}} für Eingaben in {{days}} Tagen',
  startupSourceRow: '{{source}} — {{tokens}} Tokens',
  startupSourceDetail: 'gemessen in {{sessions}} Sitzungen',
  startupResidualDetail:
    'Nicht aufgeschlüsselt — Systemprompt, Werkzeugschemata und CLAUDE.md landen nie im Sitzungsprotokoll',
  startupRebuildRow: 'Cache neu aufgebaut: {{cause}} — {{events}}-mal',
  startupRebuildDetail: '{{usd}} zusätzlich zum Lesen derselben Tokens aus dem Cache',
  startupServerRow: '{{server}} — in {{sessions}} Startblöcken',
  startupServerDetail: '{{calls}}-mal aufgerufen',

  sourceResidual: 'Systemprompt, Werkzeugschemata und Anweisungen',
  sourceSkills: 'Skill-Liste',
  sourceDeferredTools: 'Liste nachladbarer Werkzeuge',
  sourceAgentListing: 'Agentenliste',
  sourceMcpInstructions: 'Anweisungen der MCP-Server',
  sourceMemory: 'Gedächtnisdateien',
  sourceOther: 'Weitere Einschübe',
  sourceHook: 'Hook: {{name}}',

  causeCompact: 'Kontext verdichtet',
  causeTtlExpiry: 'Cache zwischen den Nachrichten abgelaufen',
  causeModelSwitch: 'Modell gewechselt',
  causeToolsChanged: 'Werkzeugumfang geändert',
  causeListingChanged: 'Skill- oder Agentenliste geändert',
  causeUnexplained: 'Ursache nicht bestimmt',

  recUnusedMcpServer: 'MCP-Server {{target}} — nie aufgerufen',
  recUnusedSkill: 'Skill {{target}} — nie verwendet',
  recDuplicateInstructions: 'Doppelter Anweisungstext in {{target}}',
  recDetail:
    'In {{sessions}} von {{total}} Starts in {{days}} Tagen · {{tokens}} Tokens pro Start · {{usd}}',
  recBadge: 'ungenutzt',
} as const;
