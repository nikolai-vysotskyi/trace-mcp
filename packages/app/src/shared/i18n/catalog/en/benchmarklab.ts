/* The Benchmark Lab screen: pick arms, run the pinned battery, read the
   measured table (TRA-1951).

   Arm names and descriptions arrive from the daemon untranslated — they name
   the shipped preset, not a sentence — so this catalogue carries only chrome.
   The daemon's error strings likewise pass through untouched: they are
   technical diagnostics, not UI copy. */

export const benchmarklab = {
  title: 'Benchmark Lab',
  refresh: 'Refresh',
  sectionSetup: 'Setup',
  projectLabel: 'Project',
  noProjects: 'No projects yet — add one in Workspace first.',
  armsLabel: 'Arms',
  batteryNote: '{{count}} fixtures × {{arms}} arms',
  run: 'Run benchmark',
  running: 'Running…',
  runningNote: 'The battery runs against the local index — usually a few seconds.',
  runFailed: 'Run failed',
  sectionResults: 'Results',
  sectionHistory: 'Past runs',
  noRunsTitle: 'No runs yet',
  noRunsSubtitle: 'Pick the arms and run the benchmark — every run is saved.',
  tableArm: 'Arm',
  tableTokens: 'Tokens',
  tableCalls: 'Calls',
  tableSuccess: 'Success',
  tableSavings: 'vs file-reading',
  tableCost: 'Cost (USD)',
  controlNote: 'control',
  exportMarkdown: 'Export markdown',
  copyMarkdown: 'Copy',
  copied: 'Copied',
  provenance: 'Measured {{date}} · build {{build}} · battery {{sha}}',
  sectionMethod: 'Method',
  methodBody:
    'Every figure is measured: exact tokens (o200k_base) over the same pinned battery. File reading is the index-free control; v1 measures no third-party servers.',
};
