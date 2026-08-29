/* Memory: decisions, the review queue, corpora and mined sessions.

   A decision's own text, its tags and the raw type value the API stores
   (`architecture_decision`) belong to the data. What is here is the reading of
   that data: the category name shown on the badge, the column captions and
   every sentence the surface writes itself. */

export const memory = {
  section: 'Memory',
  tabDecisions: 'Decisions',
  tabReview: 'Review ({{total}})',
  tabCorpora: 'Corpora',
  tabSessions: 'Sessions',
  loading: 'Loading…',

  // ── Decision categories ────────────────────────────────────────────────
  typeArchitecture: 'Architecture',
  typeTechChoice: 'Tech choice',
  typeBugRootCause: 'Bug root cause',
  typePreference: 'Preference',
  typeTradeoff: 'Trade-off',
  typeDiscovery: 'Discovery',
  typeConvention: 'Convention',

  sourceManual: 'Added by hand',
  sourceMined: 'Mined from a session',
  sourceAuto: 'Recorded automatically',

  // ── Type mix ───────────────────────────────────────────────────────────
  typeShare: '{{type}}: {{total}}',
  showOnlyType: 'Show only {{type}} decisions',

  // ── Decisions toolbar ──────────────────────────────────────────────────
  decisionsCount_one: '{{count}} decision',
  decisionsCount_other: '{{count}} decisions',
  expiredCount: '· {{total}} expired',
  excludePlaceholder: 'Exclude',
  excludeLabel: 'Exclude decisions containing',
  searchPlaceholder: 'Search decisions',
  addDecision: 'Add decision',
  moreActions: 'More actions',
  excludeField: 'Exclude field',
  clearFilters: 'Clear search and filters',

  // ── Decisions list ─────────────────────────────────────────────────────
  decisions: 'Decisions',
  found: '{{total}} found',
  foundOfTotal: '{{shown}} of {{total}}',
  /* The fragment SectionError builds "Couldn't load …" around. Kept as a noun
     phrase because the sentence itself lives in lattice/ui, not here. */
  loadFailedWhat: 'the decisions for this project',
  hiddenByExclude: '{{total}} more hidden by the exclude filter',
  narrowSearch: 'Narrow the search to see the rest',
  noMatchesTitle: 'No matching decisions',
  noMatchesSubtitle:
    'Nothing stored for this project matches the current search and filters.',
  noDecisionsTitle: 'No decisions yet',
  noDecisionsSubtitle:
    'A decision is a note about why this codebase is the way it is — a trade-off, a convention, the root cause of a bug. Assistants read them back before they change your code.',
  addFirstDecision: 'Add the first decision',

  // ── Decision card ──────────────────────────────────────────────────────
  active: 'Active',
  expired: 'Expired',
  actionsFor: 'Actions for {{title}}',
  actions: 'Actions',
  editDecision: 'Edit decision…',
  invalidateDecision: 'Invalidate decision…',
  invalidateConfirmTitle: 'Invalidate {{title}}?',
  invalidateConfirmBody:
    'It stops being read back to assistants from now on. The record itself is kept, with today as its end date.',
  invalidate: 'Invalidate',
  invalidating: 'Invalidating…',
  fieldSymbol: 'Symbol',
  fieldFile: 'File',
  fieldValidFrom: 'Valid from',
  fieldConfidence: 'Confidence',

  // ── Decision form ──────────────────────────────────────────────────────
  formTitle: 'Title *',
  formTitlePlaceholder: 'Short summary',
  formContent: 'Content *',
  formContentPlaceholder: 'Full decision text, reasoning, context…',
  formType: 'Type',
  formTags: 'Tags (comma-separated)',
  formTagsPlaceholder: 'e.g. auth, api, db',
  formFilePath: 'File path (optional)',
  formFilePathPlaceholder: 'src/auth/index.ts',
  formSymbolId: 'Symbol ID (optional)',
  formSymbolIdPlaceholder: 'MyClass.myMethod',
  titleRequired: 'Title is required',
  contentRequired: 'Content is required',
  cancel: 'Cancel',
  saving: 'Saving…',
  saveChanges: 'Save changes',
  unknownError: 'Unknown error',

  // ── Corpora ────────────────────────────────────────────────────────────
  corpora: 'Corpora',
  corporaCount_one: '{{count}} corpus',
  corporaCount_other: '{{count}} corpuses',
  noCorporaTitle: 'No corpora yet',
  noCorporaSubtitle:
    'A corpus is a saved slice of this codebase an assistant can pull in one call. Build one with the build_corpus tool.',
  corpusSize: '{{symbols}} symbols · {{files}} files',
  corpusBudget: '~{{budget}}K token budget',
  corpusKb: '{{size}} KB',
  query: 'Query',
  queryCorpus: 'Query corpus {{name}}',
  queryHeading: 'Query',
  queryPlaceholder: 'What do you want to know from this corpus?',
  queryLabel: 'Corpus query',
  search: 'Search',
  searching: 'Searching…',
  queryFailed: 'Query failed',
  tokensUsed: '~{{total}} tokens',
  copy: 'Copy',
  copied: 'Copied',
  close: 'Close',
  deleteCorpus: 'Delete corpus {{name}}',
  deleteCorpusConfirm: 'Delete corpus {{name}}?',
  deleteCorpusBody:
    'The saved slice is removed. The code it points at is untouched, and you can rebuild it.',
  deleteCorpusAction: 'Delete corpus',
  deleting: 'Deleting…',

  // ── Sessions ───────────────────────────────────────────────────────────
  minedSessions: 'Mined sessions',
  sessionsCount_one: '{{count}} session',
  sessionsCount_other: '{{count}} sessions',
  noSessionsTitle: 'No sessions mined yet',
  noSessionsSubtitle:
    'Mining reads past assistant transcripts for decisions worth keeping. Run the mine_sessions tool to fill this list.',
  sessionDecisions_one: '{{count}} decision',
  sessionDecisions_other: '{{count}} decisions',

  // ── Review queue ───────────────────────────────────────────────────────
  reviewQueue: 'Review queue',
  awaitingReviewCount: '{{total}} awaiting review',
  awaitingReview: 'Awaiting review',
  nothingToReviewTitle: 'Nothing to review',
  nothingToReviewSubtitle:
    'Decisions mined from past sessions land here first, so you can approve or reject them before assistants read them back.',
  confidence: 'Confidence',
  sessionTitle: 'Session {{id}}',
  capturedOnBranch: 'Captured on branch {{branch}}',
  approve: 'Approve',
  approving: 'Approving…',
  reject: 'Reject',
  rejecting: 'Rejecting…',
  actionFailed: 'Action failed',
  approved: 'Decision approved.',
  rejected: 'Decision rejected.',
} as const;
