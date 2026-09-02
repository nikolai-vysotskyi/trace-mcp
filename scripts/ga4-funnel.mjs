/**
 * Turning the raw snapshot rows into the four funnel numbers (TRA-645).
 *
 * Pure functions only, so they are testable without GA4 or GitHub credentials;
 * `ga4-snapshot.mjs` does the fetching and hands the rows here.
 *
 * The funnel exists because every listing rewrite, hero redesign and outreach
 * PR was being graded on taste: we had a denominator (active installs) and
 * nothing on either side of it. Its four stages are
 * arrivals → installs → activation → retention.
 */

/** GA4 returns dimension values as strings; an unset one is this literal. */
const NOT_SET = '(not set)';

/**
 * Activation from the ping's `repos_indexed` param: an install that reports
 * daily with zero indexed repositories reached the product and never reached
 * its value.
 *
 * The share is taken against the rows' own total, never against
 * `active_users.month`, because `activeUsers` is deduplicated *within* a
 * dimension value and not across them: an install that indexed its first repo
 * mid-window appears in both the `0` row and a non-zero row. Read the share as
 * "of installs seen at some level", and expect the parts to over-count the
 * whole by however many installs crossed over during the window.
 *
 * @param rows GA4 `runReport` rows, dimension `customEvent:repos_indexed`,
 *   metric `activeUsers`.
 */
export function activation(rows) {
  const buckets = { 0: 0, 1: 0, '2-5': 0, '6+': 0 };
  let unknown = 0;
  for (const row of rows ?? []) {
    const raw = row.dimensionValues?.[0]?.value;
    const users = Number(row.metricValues?.[0]?.value ?? 0);
    if (!Number.isFinite(users) || users <= 0) continue;
    // `Number('')` is 0, so an empty value must be rejected before the parse —
    // otherwise a missing reading is published as an activation failure.
    const n = !raw?.trim() || raw === NOT_SET ? Number.NaN : Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      // A value we cannot place is not evidence either way — kept visible
      // rather than folded into "0", which would invent an activation failure.
      unknown += users;
      continue;
    }
    if (n === 0) buckets['0'] += users;
    else if (n === 1) buckets['1'] += users;
    else if (n <= 5) buckets['2-5'] += users;
    else buckets['6+'] += users;
  }
  const activated = buckets['1'] + buckets['2-5'] + buckets['6+'];
  const placed = buckets['0'] + activated;
  return {
    buckets,
    unknown,
    activated,
    not_activated: buckets['0'],
    // Null, not 0: no data is a different fact from "nobody activated".
    activated_pct: placed === 0 ? null : Math.round((activated / placed) * 100),
  };
}

/** Percentage, or null when the denominator is missing — never a fake 0. */
export function share(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}
