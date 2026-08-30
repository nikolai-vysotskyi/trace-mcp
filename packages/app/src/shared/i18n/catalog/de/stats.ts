export const stats = {
  windowTitle: 'Statistik für {{project}}',
  heading: 'Statistik — {{project}}',
  refresh: 'Aktualisieren',
  refreshing: 'Wird aktualisiert…',
  exportJson: 'JSON exportieren',
  close: 'Schließen',
  loading: 'Wird geladen…',
  retry: 'Erneut versuchen',
  loadFailed: 'Statistik konnte nicht geladen werden',
  footer: 'Erstellt {{generated}} · 30 s zwischengespeichert · Esc drücken zum Schließen',

  tabIndex: 'Index',
  tabTools: 'Tools',
  tabDecisions: 'Entscheidungen',
  tabPerformance: 'Performance',
  tabSubprojects: 'Teilprojekte',
  tabQuality: 'Qualität',
  tabContent: 'Inhalt',

  noData: 'Keine Daten',
  noSectionData: 'Für diesen Bereich sind keine Daten verfügbar.',

  // ── Index ──────────────────────────────────────────────────────────────
  indexUnavailable: 'Indexdaten nicht verfügbar (Projekt nicht indexiert).',
  files: 'Dateien',
  symbols: 'Symbole',
  edges: 'Kanten',
  coverage: 'Abdeckung',
  lastIndexed: 'Zuletzt indexiert',
  edgeResolutionTiers: 'Auflösungsstufen der Kanten',

  // ── Tools ──────────────────────────────────────────────────────────────
  toolsUnavailable: 'Tool-Statistik nicht verfügbar.',
  noToolCalls: 'In den letzten 24 Std. wurden keine Tool-Aufrufe erfasst.',
  window: 'Zeitraum',
  windowHours: '{{total}} Std.',
  totalCalls: 'Aufrufe gesamt',
  perToolLatency: 'Latenz je Tool (letzte 24 Std.)',
  colTool: 'Tool',
  colCount: 'Anzahl',
  colMedian: 'Median',
  colP95: 'p95',

  // ── Decisions ──────────────────────────────────────────────────────────
  decisionsUnavailable: 'Entscheidungen nicht verfügbar (decisions.db nicht initialisiert).',
  total: 'Gesamt',
  byType: 'Nach Typ',
  confidenceHistogram: 'Konfidenz-Histogramm',
  topLinked: 'Top 5 der meistverknüpften Entscheidungen',
  noLinkedDecisions: 'Noch keine verknüpften Entscheidungen.',
  colTitle: 'Titel',
  colType: 'Typ',
  colRefs: 'Verweise',

  // ── Performance ────────────────────────────────────────────────────────
  embeddingCacheHitRate: 'Trefferquote des Embedding-Cache',
  searchP50: 'Suche p50',
  searchP95: 'Suche p95',
  indexerThroughput: 'Indexer (Dateien/s)',
  notes: 'Hinweise',

  // ── Subprojects ────────────────────────────────────────────────────────
  subprojectsUnavailable: 'Teilprojekte nicht verfügbar (topology.db nicht initialisiert).',
  noSubprojects: 'Keine Teilprojekte registriert.',
  count: 'Anzahl',
  colName: 'Name',
  colRepoRoot: 'Repo-Wurzel',
  colServices: 'Dienste',
  colEndpoints: 'Endpunkte',
  colLink: 'Link',

  // ── Quality ────────────────────────────────────────────────────────────
  deadExports: 'Tote Exporte',
  untestedSymbols: 'Ungetestete Symbole',
  complexityHotspots: 'Top 10 der Komplexitäts-Hotspots',
  noComplexityData: 'Keine Komplexitätsdaten erfasst.',
  colSymbol: 'Symbol',
  colLocation: 'Ort',
  colCyclomatic: 'Zyklomatisch',

  // ── Content ────────────────────────────────────────────────────────────
  languageDistribution: 'Sprachverteilung',
  frameworkDistribution: 'Framework-Verteilung',
  largestFiles: 'Top 10 der größten Dateien (nach Symbolanzahl)',
  colPath: 'Pfad',
  colSymbols: 'Symbole',
} as const;
