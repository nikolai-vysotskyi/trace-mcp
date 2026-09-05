/* The project window's landing surface: index summary, dependency coverage,
   the quality scan and the service list. Wording is unchanged from
   ProjectOverview.tsx — this namespace moved the strings, it did not rewrite
   them.

   The GitHub issue templates in buildIssueUrl are deliberately absent: they are
   the body of an issue filed against an English-language repository, not UI. */

export const overview = {
  // ── Toolbar and status ──
  statusChecking: 'Checking…',
  statusDaemonUnreachable: 'Daemon unreachable',
  statusNotTracked: 'Not tracked',
  statusIndexing: 'Indexing',
  statusReady: 'Ready',
  statusError: 'Error',
  statusNotIndexed: 'Not indexed',
  actionIndexing: 'Indexing…',
  actionReindex: 'Reindex',
  actionReAdd: 'Re-add project',
  actionIndex: 'Index project',
  moreActions: 'More actions',
  indexingProgress: 'Indexing progress',

  // ── Overflow and row menus ──
  menuViewStats: 'View stats',
  menuAddService: 'Add service…',
  menuOpenInEditor: 'Open in editor',
  menuOpenInGraph: 'Open in graph',
  menuSetGroup: 'Set group…',
  menuRemoveService: 'Remove service…',

  // ── Index ──
  sectionIndex: 'Index',
  /* Says only what it knows: that the numbers came from the stored
     snapshot, not from an answer this session. It names no cause — the
     Status row directly below is where the daemon's condition is
     stated, and the two disagreed on screen when this reused the
     Workspace's "The daemon is busy" sentence for every stale reading. */
  staleNumbers: 'These are the last indexed numbers.',
  rowStatus: 'Status',
  rowFiles: 'Files indexed',
  rowSymbols: 'Symbols',
  rowEdges: 'Edges',
  rowLastIndexed: 'Last indexed',
  never: 'Never',
  /* formatIndexedAt's answer for a timestamp the daemon sent us but Date
     cannot parse — not an empty value, an unreadable one. */
  unknown: 'Unknown',
  emptyIndexTitle: 'Not indexed yet',
  emptyIndexBody: 'Index this project to explore its symbols, edges and history.',

  /* SectionError composes "Couldn't load {what}." in lattice/ui, so these are
     fragments rather than sentences until that surface is extracted too. Each
     one is the object of "load", which is the case Russian needs here. */
  errorIndexSummary: 'the index summary',
  errorCoverage: 'dependency coverage',
  errorQuality: 'the quality scan',
  errorServices: 'the service list',

  // ── Coverage ──
  sectionCoverage: 'Coverage',
  coverageMeter: 'Dependency coverage',
  coverageCovered: '{{covered}} of {{total}} dependencies covered',
  emptyCoverageTitle: 'No dependencies detected',
  emptyCoverageBody:
    'Coverage appears once this project has a dependency manifest in the index.',
  emptyCoverageFoundTitle: 'No dependencies found',
  emptyCoverageFoundBody:
    'Coverage appears once the project has a dependency manifest indexed.',
  coverageRequest: 'Request',
  coverageRequestTitle: 'Open a plugin request for {{name}}',
  /* The API's own words for how badly a package wants a plugin. Shown in a
     badge, so they are read as prose and translated as prose. */
  priorityHigh: 'high',
  priorityMedium: 'medium',
  priorityLow: 'low',
  needsLikely: 'likely',
  needsMaybe: 'maybe',
  needsNo: 'no',

  // ── Quality ──
  sectionQuality: 'Quality',
  // `n` carries the locale-formatted number; `count` only picks the plural.
  findings_one: '{{n}} finding',
  findings_other: '{{n}} findings',
  smellCategoryLabel: 'Finding category',
  smellDebug: 'Debug',
  smellTodo: 'TODOs',
  smellHardcoded: 'Hardcoded',
  smellStubs: 'Stubs',
  /* Sentence-case names for the empty states — "No empty_function findings"
     was leaking the API's own enum into the UI. */
  nounDebug: 'debug artifacts',
  nounTodo: 'TODO comments',
  nounHardcoded: 'hardcoded values',
  nounStubs: 'empty functions',
  emptySmellTitle: 'No {{noun}}',
  emptySmellBody: 'Nothing to clean up in this category across {{n}} scanned files.',
  openInEditorTitle: 'Open {{file}}:{{line}} in your editor',
  moreNotShown: '{{n}} more not shown',

  // ── Services ──
  sectionServices: 'Services',
  servicesAdd: 'Add',
  emptyServicesTitle: 'No services detected',
  emptyServicesBody:
    'Services are found when the project is indexed, or you can point at a repository yourself.',
  noGroup: 'No group',
  groupPlaceholder: 'Group name',
  groupFor: 'Group for {{name}}',
  actionsFor: 'Actions for {{name}}',
  endpoints_one: '{{n}} endpoint',
  endpoints_other: '{{n}} endpoints',
  removeTitle: 'Remove {{name}}?',
  removeBody: 'The service stops being tracked here. Nothing on disk changes.',
  removeConfirm: 'Remove service',
} as const;
