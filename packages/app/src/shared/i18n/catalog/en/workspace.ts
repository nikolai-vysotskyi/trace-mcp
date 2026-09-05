/* The Workspace tab: the KPI strip, the toolbar, the project table and the
   compact list, plus the bulk bar and the add-project control.

   Project names, absolute paths and tech-debt letters are data, not text, and
   never appear here. The status words DO: "Indexing" is what the app says
   about a project, and it is the same word in the table cell, in the filter
   menu and on the KPI tile — one key each, read from all three. */

export const workspace = {
  // ── Daemon state ────────────────────────────────────────────────────────
  daemonDownTitle: "The daemon isn't running",
  daemonDownSubtitle:
    'trace-mcp indexes your projects in a local background service. Start it to see them again — nothing was lost.',
  startDaemon: 'Start daemon',
  startingDaemon: 'Starting…',
  daemonInstallingTitle: 'Setting up trace-mcp',
  daemonInstallingSubtitle: 'Installing the background service that indexes your projects. This happens once, and takes a few seconds.',
  daemonBusyTitle: 'The daemon is busy',
  daemonInstallFailedTitle: "Setup didn't finish",
  daemonInstallRetry: 'Try again',
  daemonInstallRetrying: 'Setting up…',

  /* Four whole sentences rather than a lead plus a tail: the two halves decline
     together in Russian, and a language that has to reorder them cannot if the
     app hands it two fragments. */
  busyIndexingStale_one:
    'Indexing {{indexing}} of {{total}} project. These are the last indexed numbers.',
  busyIndexingStale_other:
    'Indexing {{indexing}} of {{total}} projects. These are the last indexed numbers.',
  busyIndexingFresh_one:
    "Indexing {{indexing}} of {{total}} project. The numbers arrive when it's done.",
  busyIndexingFresh_other:
    "Indexing {{indexing}} of {{total}} projects. The numbers arrive when it's done.",
  busyStale: 'The daemon is busy. These are the last indexed numbers.',
  busyFresh: "The daemon is busy. The numbers arrive when it's done.",
  tryAgain: 'Try again',
  retrying: 'Retrying…',

  noMatchTitle: 'No projects match this filter',
  noMatchSubtitle: 'Clear the filter to see all of your projects again.',

  // ── Toolbar ─────────────────────────────────────────────────────────────
  searchProjects: 'Search projects',
  filter: 'Filter',
  viewMode: 'View mode',
  viewTable: 'Table',
  viewCompact: 'Compact',
  moreActions: 'More actions',
  refreshMetrics: 'Refresh metrics',
  refreshingMetrics: 'Refreshing metrics…',
  clearFilters: 'Clear filters',
  filterStatus: 'Status',
  filterGrade: 'Tech-debt grade',
  filterGradeItem: 'Grade {{grade}}',
  filterFindings: 'Findings',
  filterHasSecurityFindings: 'Has security findings',
  filterHasDeadExports: 'Has dead exports',
  filterStatusOkTitle: 'Projects that indexed cleanly',
  filterStatusIndexingTitle: 'Projects currently being indexed',
  filterStatusErrorTitle: 'Projects whose last index failed',

  // ── Status words (statusLabel in types.ts, and the filter menu) ──────────
  statusOk: 'OK',
  statusIndexing: 'Indexing',
  statusComputing: 'Computing',
  statusError: 'Error',
  statusNotLoaded: 'Not loaded',

  // ── KPI strip ───────────────────────────────────────────────────────────
  kpiProjects: 'Projects',
  kpiFiles: 'Files',
  kpiSymbols: 'Symbols',
  kpiHealthy: 'Healthy',
  kpiNeedsAttention: 'Needs attention',
  kpiIndexing: 'Indexing',
  kpiTrackingFromToday: 'tracking from today',
  kpiPerProject: '{{n}} per project',
  kpiPerFile: '{{n}} per file',
  kpiNoProjectsYet: 'no projects yet',
  kpiNothingIndexedYet: 'nothing indexed yet',
  kpiNothingRunning: 'nothing running',
  /**
   * What each preset tile counts. Healthy and Needs attention are
   * overlapping predicates, not two halves of the workspace, so their
   * comparison line names the criterion instead of a share of a total.
   */
  kpiHealthyCriteria: 'grade A or B, no security findings',
  kpiNeedsAttentionCriteria: 'low grade or any findings',
  kpiShare_one: '{{percent}}% of {{total}} project',
  kpiShare_other: '{{percent}}% of {{total}} projects',
  /** `when` is a relative time from i18n/format.ts, e.g. "3 days ago". */
  kpiDeltaCaption: 'vs {{when}}',
  kpiNoChange: 'No change',
  kpiNoChangeVs: 'No change {{caption}}',
  kpiNotAvailable: 'Not available',

  // ── Table ───────────────────────────────────────────────────────────────
  projectsGrid: 'Projects',
  loadingProjects: 'Loading projects',
  selectAllProjects: 'Select all projects',
  selectProject: 'Select {{name}}',
  colProject: 'Project',
  colStatus: 'Status',
  colLastIndexed: 'Last indexed',
  colFiles: 'Files',
  colSymbols: 'Symbols',
  colDeadExports: 'Dead exports',
  colDeadExportsTip: 'Exported symbols never imported anywhere in the project',
  colUntested: 'Untested',
  colUntestedTip: 'Functions, classes and methods not referenced by any test file',
  colGrade: 'Grade',
  colGradeTip: 'Tech-debt grade (A–F)',
  colSecurity: 'Security',
  colSecurityTip: 'Critical + high OWASP findings',
  colActions: 'Actions',

  // ── Row actions ─────────────────────────────────────────────────────────
  openProject: 'Open {{name}}',
  reindexProject: 'Re-index {{name}}',
  removeProjectFrom: 'Remove {{name}} from the workspace',
  reindex: 'Re-index',
  copyPath: 'Copy path',
  removeFromWorkspace: 'Remove from workspace…',
  removeProject: 'Remove project',
  cancel: 'Cancel',

  // ── Metric chips ────────────────────────────────────────────────────────
  badgeSecurity_one: '{{n}} critical+high security finding',
  badgeSecurity_other: '{{n}} critical+high security findings',
  badgeSecurityAria_one: '{{n}} critical or high security finding',
  badgeSecurityAria_other: '{{n}} critical or high security findings',
  badgeDeadExports_one: '{{n}} dead export',
  badgeDeadExports_other: '{{n}} dead exports',
  badgeUntestedTitle_one: '{{n}} untested symbol',
  badgeUntestedTitle_other: '{{n}} untested symbols',
  badgeUntested: 'untested {{n}}',

  // ── Bulk actions bar ────────────────────────────────────────────────────
  bulkSelected_one: '{{n}} selected',
  bulkSelected_other: '{{n}} selected',
  bulkRemove: 'Remove',
  bulkReindexFailed: 'Reindex failed for at least one project',
  bulkRemoveFailed: 'Remove failed for at least one project',
  bulkExportJson: 'Export JSON',
  bulkExportCsv: 'Export CSV',
  bulkClear: 'Clear',
  bulkConfirmRemove_one: 'Remove {{n}} project?',
  bulkConfirmRemove_other: 'Remove {{n}} projects?',
  bulkConfirmRemoveAction_one: 'Remove {{n}} project',
  bulkConfirmRemoveAction_other: 'Remove {{n}} projects',

  // ── Add project ─────────────────────────────────────────────────────────
  emptyTitle: 'No projects yet',
  emptySubtitle: 'Add a folder to index it, or drop one anywhere in this window.',
  addProject: 'Add project',
  addShort: '+ Add',
  add: 'Add',
  enterPath: 'Enter path…',
  chooseFolder: 'Choose a folder to index',
  addByPath: 'Add a project by path',
  enterPathManually: 'Enter path manually',
  dropFolder: 'Drop folder to add as project',
} as const;
