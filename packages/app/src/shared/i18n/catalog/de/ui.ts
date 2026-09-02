export const ui = {
  search: 'Suchen',
  clearSearch: 'Suche zurücksetzen',
  gradeBadge: 'Tech-Debt-Note {{grade}}',
  loading: 'Wird geladen',
  retry: 'Erneut versuchen',
  sectionError: '{{what}} konnte nicht geladen werden.',

  // ── FilterBar ───────────────────────────────────────────────────────────
  filterMatch: 'Treffer',
  filterExclude: 'Ausschließen',
  filterPattern: 'Teilstring oder /regex/i',
  filterDepth: 'Tiefe',
  regex: 'Regex',
  regexMode: 'Regex-Modus',
  regexInvalid: 'Ungültiger Regex (Teilstring-Fallback)',
  decreaseDepth: 'Tiefe verringern',
  decreaseDepthTitle: 'Tiefe verringern (oder auf ∞ setzen)',
  increaseDepth: 'Tiefe erhöhen',
  unlimitedDepth: 'Unbegrenzte Tiefe',
  depthLimit: 'Tiefenlimit: {{n}}',
  resetToUnlimited: 'Auf unbegrenzt zurücksetzen',
} as const;
