/* The Insights tab: three read-only reports and the words around running them.
   MCP tool ids stay out of this file for the same reason they stay off the
   screen — `check_claudemd_drift` is an internal identifier, not a title. */

export const insights = {
  title: 'Insights',
  reportPicker: 'Report',
  run: 'Run',
  refresh: 'Refresh',
  running: 'Running…',
  /* The run button's accessible name: the action plus which report it acts on,
     since three reports share one button. */
  runAction: '{{action}} {{report}}',
  unknownError: 'Unknown error',
  /* The daemon handshake, said in the error box rather than only in a log.
     `Unknown report id` is deliberately not here: that throw is a programmer
     assertion for an id the picker cannot produce. */
  errorInit: "Couldn't start a session with the daemon (HTTP {{status}}).",
  errorNoSession: 'The daemon started a session but did not name it.',
  errorHttp: 'The report request failed (HTTP {{status}}). {{detail}}',
  errorToolFailed: 'The report did not run.',

  reportDriftTitle: 'CLAUDE.md drift',
  reportDriftDescription: 'Stale paths and dead symbol references in agent config files.',
  reportPagerankTitle: 'Top central files',
  reportPagerankDescription:
    'Most architecturally central files by PageRank on the import graph.',
  reportRiskTitle: 'Risk hotspots',
  reportRiskDescription: 'Files combining high complexity with high git churn.',

  /* Announced to a screen reader while the report runs — the skeleton alone is
     silent. What the report is DOING, in the user's terms. */
  runningDrift: 'Checking agent config against the index…',
  runningPagerank: 'Ranking files by import centrality…',
  runningRisk: 'Correlating complexity with git churn…',

  emptyTitle: 'Nothing to report',
  emptyBody: 'This report came back empty — nothing in the project matches it right now.',

  // ── Row text produced by the flatteners ──
  noDescription: '(no description)',
  rowIssue: '{{location}} — {{issue}}',
  rowFix: 'Fix: {{fix}}',
  rowScore: 'score {{score}}',
  rowHotspot: 'complexity {{complexity}} · {{commits}} commits',
  rowHotspotConfidence: 'complexity {{complexity}} · {{commits}} commits · {{confidence}}',
} as const;
