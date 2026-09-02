/* Defaults the shared primitives ship with — the placeholder a SearchField
   shows when a caller gives it none, the accessible name of the clear button,
   the words a GradeBadge spells its letter out with.

   A label a component takes as a PROP is not in here: the caller owns that
   string and translates it in its own namespace. Only what the primitive says
   on its own behalf belongs to `ui`. */

export const ui = {
  search: 'Search',
  clearSearch: 'Clear search',
  gradeBadge: 'Tech debt grade {{grade}}',
  loading: 'Loading',
  retry: 'Retry',
  sectionError: "Couldn't load {{what}}.",
  sectionsError: "Couldn't load {{what}}.",

  // ── FilterBar ───────────────────────────────────────────────────────────
  filterMatch: 'Match',
  filterExclude: 'Exclude',
  filterPattern: 'substring or /regex/i',
  filterDepth: 'Depth',
  regex: 'regex',
  regexMode: 'Regex mode',
  regexInvalid: 'Invalid regex (substring fallback)',
  decreaseDepth: 'Decrease depth',
  decreaseDepthTitle: 'Decrease depth (or set to ∞)',
  increaseDepth: 'Increase depth',
  unlimitedDepth: 'Unlimited depth',
  depthLimit: 'Depth limit: {{n}}',
  resetToUnlimited: 'Reset to unlimited',
} as const;
