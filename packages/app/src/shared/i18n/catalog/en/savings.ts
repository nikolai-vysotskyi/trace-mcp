/* The Savings screen: one figure — the input tokens trace-mcp gave back to this
   install — and the sentences that keep it honest (TRA-1091).

   Model ids and the currency amount are data, not text: they arrive formatted
   from the daemon and pass through the interpolation untouched. */

export const savings = {
  title: 'Savings',
  refresh: 'Refresh',
  heroLabel: 'Input tokens given back',
  heroValue: 'At least {{tokens}}',
  heroUsd: 'About {{usd}}, priced at {{model}} ({{rate}} per million input tokens) — the cheapest current rate.',
  sectionBreakdown: 'How it was counted',
  rowBaseline: 'File-reading baseline (estimated)',
  rowReturned: 'Tokens returned (measured)',
  rowReduction: 'Reduction',
  rowCalls: 'Measured tool calls',
  rowExcluded: 'Calls excluded as unmeasured',
  rowSince: 'Counting since',
  unknown: 'Unknown',
  sectionMethod: 'Method',
  methodBody: 'The returned half is an estimate (chars/4) of the tokens that went over the wire. The baseline half — what the same questions would have cost as file reads — is still an estimate, so this figure is a floor, not a headline.',
  methodLink: 'Read the method',
  notEnoughTitle: 'Not enough measured calls yet',
  notEnoughSubtitle: 'Use trace-mcp from your agent for a while, then check back.',
};
