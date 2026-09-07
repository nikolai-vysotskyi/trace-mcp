/**
 * The one number trace-mcp shows a user about itself: how much input token
 * spend it gave back to *this* install (TRA-1091).
 *
 * Every surface that prints that number — `trace savings`, `trace doctor`,
 * `GET /api/savings`, the desktop app — calls {@link buildSavingsReport} and
 * prints what it returns. There is deliberately no second computation
 * anywhere: the reason this feature exists at all is that the previous
 * published figure was `calls x constant` (TRA-880), and a figure with two
 * implementations is a figure that will drift back into that.
 *
 * Three rules this module enforces, not the callers:
 *
 * 1. **Measured only.** Reads {@link PersistentSavings.measured}, never
 *    `total_tokens_saved`. The totals include the pre-TRA-880 guess and every
 *    call whose response was never counted; the measured block is only
 *    incremented from a real `o200k_base`-scale count of the bytes that went
 *    over the wire.
 * 2. **A floor, not a headline.** Dollars are priced at the cheapest current
 *    Claude input rate, so the figure understates for anyone on a bigger model
 *    — the same convention `docs/_data/adoption.yml` already publishes under.
 * 3. **Say "not enough data".** Below {@link MIN_MEASURED_CALLS} the report is
 *    `enough_data: false` and carries no savings figure. Printing a 0, or
 *    extrapolating from four calls, is worse than printing nothing.
 *
 * The baseline half is still `RAW_COST_ESTIMATES` — hand-written, unvalidated,
 * and named as such on every surface. See `docs/perf/response-tokens.md`.
 */

import { loadPersistentSavings, type MeasuredSavings, type PersistentSavings } from './savings.js';

/**
 * Cheapest published Claude input price, USD per token. Deliberately the
 * cheapest: the report is a lower bound, and a lower bound priced at Opus
 * would be a marketing number wearing a lower bound's clothes.
 */
export const FLOOR_PRICE_MODEL = 'claude-haiku-4-5';
export const FLOOR_PRICE_PER_MTOK_USD = 1.0;

/**
 * Measured calls below which the report refuses to state a figure. Small
 * enough that a normal afternoon clears it, large enough that one unlucky
 * `get_dead_code` doesn't define the install's ratio.
 */
export const MIN_MEASURED_CALLS = 25;

export const METHODOLOGY_URL = 'https://trace-mcp.com/perf/response-tokens/';

export interface SavingsReport {
  /** False when this install has too few measured calls to state anything. */
  enough_data: boolean;
  /** Measured calls behind the figure. Present even when `enough_data` is false. */
  calls: number;
  /** Calls recorded but never scored against a real response — excluded above. */
  unmeasured_calls: number;
  /** Estimated tokens the same questions would have cost as raw reads. */
  baseline_tokens: number;
  /** Real tokens trace-mcp's responses cost. */
  response_tokens: number;
  /** `baseline_tokens - response_tokens`, floored per call at zero. */
  tokens_saved: number;
  /** Share of the baseline given back, 1 decimal. */
  reduction_pct: number;
  /** `tokens_saved` at {@link FLOOR_PRICE_PER_MTOK_USD}. A floor. */
  usd_saved_floor: number;
  price_model: string;
  price_per_mtok_usd: number;
  /** ISO date of the first recorded session, or null when the store is empty. */
  since: string | null;
  /** Why the baseline is an estimate and the dollars are a floor. */
  methodology_url: string;
  /** Set when `enough_data` is false — the sentence to show instead of a number. */
  reason?: string;
}

/**
 * Build the report from a persistent store. Pass `null`/omit to read
 * `~/.trace/savings.json`.
 */
export function buildSavingsReport(
  store: PersistentSavings | null = loadPersistentSavings(),
): SavingsReport {
  const measured: MeasuredSavings = store?.measured ?? {
    calls: 0,
    tokens_saved: 0,
    raw_tokens: 0,
    actual_tokens: 0,
  };
  const totalCalls = store?.total_calls ?? 0;
  const base = {
    calls: measured.calls,
    unmeasured_calls: Math.max(0, totalCalls - measured.calls),
    baseline_tokens: measured.raw_tokens,
    response_tokens: measured.actual_tokens,
    tokens_saved: measured.tokens_saved,
    reduction_pct:
      measured.raw_tokens > 0
        ? Math.round((measured.tokens_saved / measured.raw_tokens) * 1000) / 10
        : 0,
    usd_saved_floor:
      Math.round((measured.tokens_saved / 1_000_000) * FLOOR_PRICE_PER_MTOK_USD * 100) / 100,
    price_model: FLOOR_PRICE_MODEL,
    price_per_mtok_usd: FLOOR_PRICE_PER_MTOK_USD,
    since: store?.first_session ?? null,
    methodology_url: METHODOLOGY_URL,
  };

  if (measured.calls < MIN_MEASURED_CALLS) {
    return {
      ...base,
      enough_data: false,
      reason:
        totalCalls > measured.calls
          ? `Not enough measured calls yet (${measured.calls} of ${MIN_MEASURED_CALLS}). ${base.unmeasured_calls} earlier calls were recorded before responses were measured and are not counted.`
          : `Not enough measured calls yet (${measured.calls} of ${MIN_MEASURED_CALLS}). Use trace-mcp from your agent for a while and check back.`,
    };
  }

  return { ...base, enough_data: true };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** Human-readable block for `trace savings` and `trace doctor`. */
export function formatSavingsReport(r: SavingsReport): string {
  if (!r.enough_data) {
    return `Token savings: not enough data yet.\n  ${r.reason}\n  Method: ${r.methodology_url}`;
  }
  const since = r.since ? ` since ${r.since.slice(0, 10)}` : '';
  return [
    `Token savings${since}: at least ${fmt(r.tokens_saved)} input tokens (~$${r.usd_saved_floor.toFixed(2)})`,
    `  ${fmt(r.calls)} measured tool calls: ${fmt(r.response_tokens)} tokens returned against a ${fmt(r.baseline_tokens)}-token file-reading baseline — ${r.reduction_pct}% less.`,
    `  "At least": dollars priced at ${r.price_model} ($${r.price_per_mtok_usd.toFixed(2)}/Mtok input), the cheapest current rate; the baseline half is an estimate.`,
    r.unmeasured_calls > 0
      ? `  ${fmt(r.unmeasured_calls)} calls are excluded — recorded before their responses were measured.`
      : null,
    `  Method: ${r.methodology_url}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}
