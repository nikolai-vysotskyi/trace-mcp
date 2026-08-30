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
} as const;
