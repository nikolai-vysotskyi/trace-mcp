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
 *
 *    That rate is the *cheapest* of the three models `src/analytics/real-savings.ts`
 *    prices, so the published dollar figure is a floor: whatever mix of models
 *    our installs actually run, nobody saved less than this. Pricing at Opus —
 *    the most expensive of the three, and 5x the floor — would need a caveat
 *    printed next to the number every time it is quoted, and the one thing a
 *    screenshot reliably loses is the caveat. A blended rate would be the
 *    honest middle, but we do not measure the model mix these savings came
 *    from, so any blend we picked would be invented weights wearing a decimal
 *    point.
 *
 *    ponytail: the ping already carries a `model` param, so segmenting
 *    `tokens_saved` by `customEvent:model` and pricing each slice at its own
 *    rate would give a real blend. Worth doing once that dimension is
 *    registered in GA4 and has enough history to be stable; until then the
 *    floor is the number that cannot be wrong in our favour.
 */

/**
 * Claude Haiku input price, per token — the cheapest tracked model, making the
 * published figure a floor rather than a best case. Kept in sync with
 * `MODEL_PRICING` in `src/analytics/real-savings.ts` by
 * tests/scripts/ga4-savings.test.ts — the snapshot runs in CI without a build
 * step, so it cannot import the TypeScript.
 */
export const PRICE_MODEL = 'claude-haiku-4-5';
export const PRICE_PER_TOKEN = 1.0 / 1_000_000;

/**
 * Multiple of the median per-user day above which a day is treated as inflated.
 * 5x is loose enough that a genuine busy day survives untouched and tight
 * enough that a flood cannot dominate the total.
 */
const OUTLIER_FACTOR = 5;

/**
 * Fewer days than this and there is no median worth trimming against, so
 * `sanitizedTokens` returns the raw sum unchanged.
 *
 * Exported because that makes the result *unsanitized*, and anything that
 * publishes the figure has to refuse it rather than call it sanitized —
 * `scripts/refresh-savings.mjs` gates on this exact constant.
 */
export const MIN_DAYS_FOR_TRIM = 5;

/**
 * `raw / tokens` above which the run says so out loud (TRA-843).
 *
 * The gap between the raw and the sanitized total was described as "the signal
 * that someone is flooding the endpoint" while being written to a file nobody
 * diffs — it went 4.95x → 5.21x in a day, on a day that overlaps a documented
 * npm/clone harvest (`ops/user-signal.md`, private repo), and no run noticed. 2x is the point
 * where more than half of what the endpoint received was capped away, so the
 * published figure has stopped being a measurement of anything and become the
 * ceiling the sanitizer chose.
 *
 * Deliberately a warning and not a failure: the snapshot file is the only
 * durable record of the trend (GA4 retains 14 months), so failing the workflow
 * would answer a flood by throwing away the day's evidence of it. The sanitizer
 * is what protects the number; this only makes the firing visible.
 */
export const INFLATION_RATIO = 2;

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
 * were capped, so the caller can publish that alongside the number, and
 * `raw_ratio` / `inflation_suspected` (TRA-843) so the gap the header calls a
 * tripwire is a value someone can act on rather than a subtraction they have to
 * remember to do across two snapshots.
 */
export function sanitizedTokens(days) {
  const r = trim(days);
  const ratio = r.tokens > 0 ? r.raw / r.tokens : null;
  return {
    ...r,
    // Rounded to two places so a day-to-day move is legible in a diff of the
    // published file, which is where anyone reads this from — but the threshold
    // is tested against the exact ratio, or 2.0004 would round to a displayed
    // `2` and report itself as under a rule it is over.
    raw_ratio: ratio === null ? null : Math.round(ratio * 100) / 100,
    inflation_suspected: ratio !== null && ratio > INFLATION_RATIO,
  };
}

function trim(days) {
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
