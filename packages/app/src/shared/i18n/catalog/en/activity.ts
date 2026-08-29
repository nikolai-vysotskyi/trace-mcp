/* The Activity surface and its two feeds — MCP tool calls (ToolActivity) and
   the daemon's own embed / generate / rerank requests (AIActivity). They share
   a toolbar, a feed-state vocabulary and a unit scale, so they share one
   namespace rather than three that would have to agree by hand.

   Wording is unchanged from the three components; `n` carries the
   locale-formatted number where a raw `count` would print 1,234 in Russian. */

export const activity = {
  // ── Container ──
  sourceLabel: 'Activity source',
  sourceTool: 'Tool calls',
  sourceAi: 'AI calls',

  // ── Units. Not prose, but they are read aloud and Russian spells them
  //    differently, so they belong here rather than inline. ──
  ms: '{{n}} ms',
  seconds: '{{n}} s',
  msCompact: '{{n}}ms',
  secondsCompact: '{{n}}s',
  msUnder10: '<10ms',
  secondsOver: '5s+',
  window5m: '5m',
  window1h: '1h',
  window6h: '6h',
  window24h: '24h',

  // ── Feed state, shared by both surfaces ──
  feedLive: 'Live',
  feedIdle: 'Idle',
  feedRunning: 'Running',
  feedOffline: 'Offline',
  feedPaused: 'Paused ({{n}})',

  // ── Tool calls: toolbar ──
  calls_one: '{{n}} call',
  calls_other: '{{n}} calls',
  filters_one: '{{n}} filter',
  filters_other: '{{n}} filters',
  clearAllFilters: 'Clear all filters',
  searchCalls: 'Search calls',
  pause: 'Pause the live feed',
  resume: 'Resume the live feed',
  moreActions: 'More actions',

  // ── Tool calls: overflow menu ──
  menuErrorsOnly: 'Errors only',
  menuGroupBySession: 'Group by session',
  menuTools: 'Tools',
  menuClearFilters: 'Clear filters',
  menuExport_one: 'Export {{n}} call as JSONL',
  menuExport_other: 'Export {{n}} calls as JSONL',
  menuClearFeed: 'Clear the local feed',
  menuShortcuts: 'Keyboard shortcuts',
  confirmClear: 'Clear local activity buffer?',

  // ── Tool calls: stats ──
  stats: 'Stats',
  statsLabel: 'Statistics',
  statsWindow: 'Stats window',
  statCalls: 'calls',
  statErrors: 'errors',
  statP95: 'p95',
  /* "new" is what the delta badge says when the previous window had no data at
     all — there is no ratio to render. */
  deltaNew: 'new',
  deltaTitle: 'vs previous {{window}}: {{prev}} → {{cur}}',
  deltaTitleUnit: 'vs previous {{window}}: {{prev}} → {{cur}} {{unit}}',
  chartHotTools: 'Most-used tools',
  chartHotFiles: 'Most-read files',
  chartLatency: 'Latency',
  chartErrorGroups: 'Errors by tool',
  chartSparkline: 'Last {{window}}',
  hotToolTitle: 'avg {{ms}}ms · {{errors}} errors',
  hotToolErrors: '{{n}} errors',
  latencyBucketTitle_one: '{{bucket}}: {{n}} call',
  latencyBucketTitle_other: '{{bucket}}: {{n}} calls',
  errorSampleShow: 'Show a sample error for {{tool}}',
  errorSampleHide: 'Hide a sample error for {{tool}}',
  errorSampleShowShort: 'Show sample',
  errorSampleHideShort: 'Hide sample',
  errorGroupFilter: 'Show only {{tool}} errors',
  noErrorsInWindow: 'No errors in this window.',
  clearTimeRange: 'Clear time-range filter',
  clear: 'Clear',
  sparklineTitle: '{{time}}: {{calls}} calls',
  sparklineTitleErrors: '{{time}}: {{calls}} calls, {{errors}} errors',

  // ── Tool calls: rows ──
  copied: 'Copied',
  copy: 'Copy',
  copyParams: 'Copy full params to clipboard',
  filePathNavigate: 'Click to open in Graph · ⌥-click to copy path',
  filePathCopy: 'Click to copy path',
  results_one: '{{n}} result',
  results_other: '{{n}} results',
  tokensApprox: '~{{n}} tokens',
  detailTime: 'Time',
  detailSession: 'Session',
  detailTool: 'Tool',
  detailParams: 'Params',
  detailResults: 'Results',
  detailLatency: 'Latency',
  detailTokens: 'Tokens',
  detailError: 'Error',
  detailErrorBody: 'This call returned an error.',
  groupErrors_one: '{{n}} error',
  groupErrors_other: '{{n}} errors',

  // ── Tool calls: keyboard help ──
  shortcutsTitle: 'Keyboard shortcuts',
  shortcutsClose: 'Press Esc or ? to close.',
  shortcutSearch: 'Focus search',
  shortcutNext: 'Next call',
  shortcutPrev: 'Previous call',
  shortcutExpand: 'Expand or collapse the selected call',
  shortcutEscape: 'Clear the search, then the filters, then the selection',
  shortcutHelp: 'Show or hide this list',

  // ── Tool calls: feed states ──
  sseLost: 'SSE connection lost — reconnecting…',
  emptyUnreachableTitle: "Can't reach the indexer",
  emptyUnreachableBody:
    "The trace-mcp daemon didn't answer, so this project's earlier calls couldn't be loaded. Anything new still arrives live.",
  tryAgain: 'Try again',
  emptyCallsTitle: 'No tool calls yet',
  emptyCallsBody:
    'Every trace-mcp call an assistant makes against this project lands here, live. Connect a client to start the feed.',
  connectClient: 'Connect a client',
  emptyMatchTitle: 'No matching calls',
  emptyMatchFiltered_one: '{{n}} call is hidden by the current filters.',
  emptyMatchFiltered_other: '{{n}} calls are hidden by the current filters.',
  emptyMatchSearch: 'Nothing in the feed matches that search.',
  clearFiltersAndSearch: 'Clear filters and search',

  // ── AI calls ──
  typeEmbed: 'Embed',
  typeBatch: 'Batch',
  typeGenerate: 'Generate',
  typeStream: 'Stream',
  typeRerank: 'Rerank',
  statusOk: 'OK',
  statusError: 'Error',
  statusRunning: 'Running',
  running: 'running…',
  overFiveSeconds: 'Over 5 seconds',
  requests_one: '{{n}} request',
  requests_other: '{{n}} requests',
  showEveryType: 'Show every request type',
  searchRequests: 'Search requests',
  metricRequests: 'Requests',
  metricLatency: 'Average latency',
  metricErrors: 'Errors',
  metricTypes_one: '{{n}} type',
  metricTypes_other: '{{n}} types',
  metricTotal: '{{duration}} total',
  metricErrorRate: '{{pct}}% of requests',
  metricNoErrors: 'None so far',
  typeAll: 'All {{n}}',
  typeCount: '{{label}}: {{n}}',
  typeFilter: 'Show only {{label}} requests',
  connecting: 'Connecting to the daemon…',
  errorAiHistory: 'AI request history',
  emptyRequestsTitle: 'No AI requests yet',
  emptyRequestsBody:
    'Embedding, generation and rerank calls show up here while a project indexes or a semantic search runs.',
  emptyRequestsMatchTitle: 'No matching requests',
  emptyRequestsMatch_one: '{{n}} request is hidden by the current search and filter.',
  emptyRequestsMatch_other: '{{n}} requests are hidden by the current search and filter.',
  detailUrl: 'URL',
  detailInput: 'Input',
  detailOutput: 'Output',
  items: '{{n}} items',
  chars: '{{n}} chars',
  vectors: '{{n}} vectors',
} as const;
