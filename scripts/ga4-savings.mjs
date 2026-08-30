/**
 * Turning the `tokens_saved` ping counter into a number we can publish.
 *
 * Two jobs, both deliberately done here rather than in the client (TRA-533):
 *
 * 1. **Sanitizing.** The ping's GA4 credentials ship in the published bundle
 *    (SECURITY.md "Telemetry Credentials"), so the events are unauthenticated
 *    and anyone can inflate the counter. A raw sum is therefore not publishable.
 *    The GA4 Data API has no `client_id` dimension — that only exists in the
 *    BigQuery export — so per-install outlier rejection is not available to us.
 *    What is available is a daily series, so we cap each day's contribution at
 *    a multiple of the median day's per-user rate. A single install flooding
 *    the endpoint moves one day, and that day is capped to what a normal day of
 *    that many users looks like.
 *
 * 2. **Pricing.** The ping carries tokens, never dollars. Dollars are derived
 *    at report time from one published rate, so a price change re-prices the
 *    whole history instead of freezing whatever list price was current when
 *    each install pinged.
 */

/**
 * Claude Opus input price, per token. Kept in sync with `MODEL_PRICING` in
 * `src/analytics/real-savings.ts` by tests/scripts/ga4-savings.test.ts — the
 * snapshot runs in CI without a build step, so it cannot import the TypeScript.
 */
export const PRICE_MODEL = 'claude-opus-4-6';
export const PRICE_PER_TOKEN = 5.0 / 1_000_000;

/**
 * Multiple of the median per-user day above which a day is treated as inflated.
 * 5x is loose enough that a genuine busy day survives untouched and tight
 * enough that a flood cannot dominate the total.
 */
const OUTLIER_FACTOR = 5;

/** Fewer days than this and there is no median worth trimming against. */
const MIN_DAYS_FOR_TRIM = 5;

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Sum a daily `{ tokens, users }` series with inflated days capped.
 *
 * Capped, not dropped: an inflated day still had real users on it, and
 * discarding it would under-count them. Returns the total plus how many days
 * were capped, so the caller can publish that alongside the number.
 */
export function sanitizedTokens(days) {
  const clean = days
    .map((d) => ({
      tokens: Math.max(0, Number(d.tokens) || 0),
      users: Math.max(1, Number(d.users) || 0),
    }))
    .filter((d) => Number.isFinite(d.tokens));
  if (clean.length === 0) return { tokens: 0, raw: 0, days: 0, capped_days: 0 };

  const raw = Math.round(clean.reduce((sum, d) => sum + d.tokens, 0));
  if (clean.length < MIN_DAYS_FOR_TRIM) {
    return { tokens: raw, raw, days: clean.length, capped_days: 0 };
  }

  const ceilingRate = median(clean.map((d) => d.tokens / d.users)) * OUTLIER_FACTOR;
  // An all-zero history has a zero median; capping at 0 would erase everything.
  if (ceilingRate <= 0) return { tokens: raw, raw, days: clean.length, capped_days: 0 };

  let total = 0;
  let capped = 0;
  for (const d of clean) {
    const ceiling = ceilingRate * d.users;
    if (d.tokens > ceiling) capped++;
    total += Math.min(d.tokens, ceiling);
  }
  return { tokens: Math.round(total), raw, days: clean.length, capped_days: capped };
}

/** Dollars for a token count, at the one rate this file publishes. */
export function usd(tokens) {
  return Math.round(tokens * PRICE_PER_TOKEN * 100) / 100;
}
