/* The per-project stats modal: seven tabs of index, tool, decision and content
   numbers.

   Values the daemon computes and names itself — a language, a framework, a
   decision type, a resolution tier, a link-health word — pass through as the
   payload spelled them. */

export const stats = {
  windowTitle: 'Stats for {{project}}',
  heading: 'Stats — {{project}}',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  exportJson: 'Export JSON',
  close: 'Close',
  loading: 'Loading…',
  retry: 'Retry',
  loadFailed: 'Failed to load stats',
  footer: 'Generated {{generated}} · cached 30s · press Esc to close',

  tabIndex: 'Index',
  tabTools: 'Tools',
  tabDecisions: 'Decisions',
  tabPerformance: 'Performance',
  tabSubprojects: 'Subprojects',
  tabQuality: 'Quality',
  tabContent: 'Content',

  noData: 'No data',
  noSectionData: 'No data available for this section.',

  // ── Index ──────────────────────────────────────────────────────────────
  indexUnavailable: 'Index data unavailable (project not indexed).',
  files: 'Files',
  symbols: 'Symbols',
  edges: 'Edges',
  coverage: 'Coverage',
  lastIndexed: 'Last Indexed',
  edgeResolutionTiers: 'Edge resolution tiers',

  // ── Tools ──────────────────────────────────────────────────────────────
  toolsUnavailable: 'Tool stats unavailable.',
  noToolCalls: 'No tool calls recorded in the last 24h.',
  window: 'Window',
  windowHours: '{{total}}h',
  totalCalls: 'Total calls',
  perToolLatency: 'Per-tool latency (last 24h)',
  colTool: 'Tool',
  colCount: 'Count',
  colMedian: 'Median',
  colP95: 'p95',

  // ── Decisions ──────────────────────────────────────────────────────────
  decisionsUnavailable: 'Decisions unavailable (decisions.db not initialised).',
  total: 'Total',
  byType: 'By type',
  confidenceHistogram: 'Confidence histogram',
  topLinked: 'Top 5 most-linked decisions',
  noLinkedDecisions: 'No linked decisions yet.',
  colTitle: 'Title',
  colType: 'Type',
  colRefs: 'Refs',

  // ── Performance ────────────────────────────────────────────────────────
  embeddingCacheHitRate: 'Embedding cache hit rate',
  searchP50: 'Search p50',
  searchP95: 'Search p95',
  indexerThroughput: 'Indexer (files/s)',
  notes: 'Notes',

  // ── Subprojects ────────────────────────────────────────────────────────
  subprojectsUnavailable: 'Subprojects unavailable (topology.db not initialised).',
  noSubprojects: 'No subprojects registered.',
  count: 'Count',
  colName: 'Name',
  colRepoRoot: 'Repo Root',
  colServices: 'Services',
  colEndpoints: 'Endpoints',
  colLink: 'Link',

  // ── Quality ────────────────────────────────────────────────────────────
  deadExports: 'Dead exports',
  untestedSymbols: 'Untested symbols',
  complexityHotspots: 'Top 10 complexity hotspots',
  noComplexityData: 'No complexity data recorded.',
  colSymbol: 'Symbol',
  colLocation: 'Location',
  colCyclomatic: 'Cyclomatic',

  // ── Content ────────────────────────────────────────────────────────────
  languageDistribution: 'Language distribution',
  frameworkDistribution: 'Framework distribution',
  largestFiles: 'Top 10 largest files (by symbol count)',
  colPath: 'Path',
  colSymbols: 'Symbols',
} as const;
