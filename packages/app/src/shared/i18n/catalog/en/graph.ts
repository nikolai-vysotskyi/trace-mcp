/* Graph Explorer: the toolbar, the overflow menu, the colour legend, the
   bottleneck hotspots panel and the Stress Test HUD.

   Not here, on purpose:
   - the AI prompt buildBottleneckPrompt assembles. It is addressed to a model,
     not to the reader — the same reason AskTab does not touch what the daemon
     streams back. The chrome around it (its heading, its hint, its Copy
     button) is here.
   - a message the daemon sent. graph-error.ts passes those through verbatim;
     only the sentence the app substitutes for a bare transport failure is a
     string of ours. */

export const graph = {
  // ── Failure ────────────────────────────────────────────────────────────
  daemonUnreachable: "Can't reach the trace-mcp daemon.",
  serverError: 'Server error ({{status}})',
  tooManyRequests: 'Too many requests (retrying…)',

  // ── Toolbar ────────────────────────────────────────────────────────────
  granularity: 'Graph granularity',
  files: 'Files',
  symbols: 'Symbols',
  filter: 'Filter',
  filterTitle: 'Filter nodes by name and depth',
  filtersLabel: 'Graph filters',
  filterMatchPlaceholder: 'substring or /regex/i',
  filterExcludePlaceholder: 'hide nodes matching…',
  search: 'Search',
  searchNodes: 'Search nodes',
  /* `total`, not `count`: i18next reserves `count` for plural selection, and
     these numbers sit next to a noun that does not have to inflect with them
     in either language. Only `pieces` below is a real plural. */
  selectAllMatches: 'Select all {{total}} matches',
  fit: 'Fit',
  fitTitle: 'Fit view & pause (F)',
  live: 'Live',
  paused: 'Paused',
  pauseSimulation: 'Pause simulation (Space)',
  resumeSimulation: 'Resume simulation (Space)',
  moreOptions: 'More options',
  moreOptionsLabel: 'More graph options',

  // ── Overflow menu ──────────────────────────────────────────────────────
  colourBy: 'Colour by',
  colourByCommunity: 'Community',
  colourByLanguage: 'Language',
  colourByFrameworkRole: 'Framework role',
  colourFallback: 'Colour',
  show: 'Show',
  labels: 'Labels',
  hideUnconnected: 'Hide unconnected nodes',
  bottlenecks: 'Bottlenecks',
  highlightGroup: 'Highlight group',
  clearHighlight: 'Clear highlight',
  reloadGraph: 'Reload graph',
  developer: 'Developer',
  frameRateCounter: 'Frame rate counter',
  fpsUnit: 'fps',
  stressTest: 'Stress test',

  // ── Legend + pane state ────────────────────────────────────────────────
  other: 'Other',
  stats: '{{nodes}} nodes · {{edges}} edges · {{communities}} groups',
  building: 'Building graph…',
  buildingSubtitle: 'Reading the index and laying out the nodes.',
  buildFailed: "Couldn't build the graph",
  retry: 'Retry',

  // ── Bottleneck hotspots ────────────────────────────────────────────────
  bottleneckScore: 'Bottleneck score',
  scaleLow: 'low',
  scaleHigh: 'high',
  articulationPoint: 'articulation point',
  topHotspots: 'Top {{total}} hotspots',
  bridge: 'Bridge',
  hotspotTitle: '{{source}} → {{target}}\nScore {{score}}',
  hotspotTitleBridge: '{{source}} → {{target}}\nScore {{score}} (bridge)',

  // ── Stress Test HUD ────────────────────────────────────────────────────
  stressTitle: 'What if — remove critical links',
  autoBadge: 'AUTO ×{{total}}',
  breaksAxis: '{{total}} breaks',
  graphIntact: 'Graph intact',
  fragmentedInto: 'Fragmented into',
  pieces_one: '{{count}} piece',
  pieces_other: '{{count}} pieces',
  orphanedFiles: 'Orphaned files',
  edgesRemoved: 'Edges removed',
  stop: '⏸ Stop',
  stopTitle: 'Stop auto-destruction',
  breakNext: 'Break next',
  breakNextTitle: 'Remove the highest-scoring remaining edge',
  auto: '▶ Auto',
  autoTitle: 'Auto: remove the top {{total}} hottest edges one by one with animation',
  autoCountTitle: 'How many edges Auto should break in this run',
  reset: 'Reset',
  resetTitle: 'Restore all broken edges and clear history',

  // ── Hover / selection popup ────────────────────────────────────────────
  nodeMeta: '{{type}} · {{language}} · community {{community}} · imp {{importance}}',
  copyPath: 'Copy path',
  copyPathTitle: 'Copy full path',
  copied: '✓ Copied',
  openIn: 'Open in {{name}}',
  closeSelection: 'Close',
  aiPromptEdge: 'AI prompt · this edge',
  aiPromptFile: 'AI prompt · this file',
  copyPrompt: '✨ Copy',
  copyPromptTitle: 'Copy the prompt below to your clipboard',
  promptHint:
    'Copy this and paste into Claude / ChatGPT to investigate the bottleneck and get refactoring suggestions.',
} as const;
