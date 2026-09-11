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
 *    call whose response was never counted; the measured block is incremented
 *    from measured response wire bytes converted via a zero-overhead chars/4
 *    estimate (0.250 tokens/char, reflecting the 0.220–0.368 ratio spread
 *    observed on o200k_base across the busiest tools in harness benchmarks).
 * 2. **Priced honestly.** Detects the user's actual active model from recent
 *    sessions/activity to compute realistic dollar savings, falling back to the
 *    cheapest current Claude input rate floor only when no activity data exists.
 * 3. **Say "not enough data".** Below {@link MIN_MEASURED_CALLS} the report is
 *    `enough_data: false` and carries no savings figure. Printing a 0, or
 *    extrapolating from four calls, is worse than printing nothing.
 *
 * The baseline half is still `RAW_COST_ESTIMATES` — hand-written, unvalidated,
 * and named as such on every surface. See `docs/perf/response-tokens.md`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { TRACE_MCP_HOME } from './global.js';
import { loadPersistentSavings, type MeasuredSavings, type PersistentSavings } from './savings.js';

/**
 * Cheapest published Claude input price, USD per token. Used as a floor fallback
 * when no user sessions or models can be detected from analytics.
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

export interface DetectedModelInfo {
  model: string;
  price_per_mtok_usd: number;
  source: 'detected' | 'fallback';
}

export interface BuildSavingsReportOptions {
  modelInfo?: DetectedModelInfo;
  analyticsDbPath?: string;
  envModel?: string;
}

export interface SavingsReport {
  /** False when this install has too few measured calls to state anything. */
  enough_data: boolean;
  /** Measured calls behind the figure. Present even when `enough_data` is false. */
  calls: number;
  /** Calls recorded but never scored against a real response — excluded above. */
  unmeasured_calls: number;
  /** Estimated tokens the same questions would have cost as raw reads. */
  baseline_tokens: number;
  /** Estimated tokens trace-mcp's responses cost (chars/4 heuristic on wire text). */
  response_tokens: number;
  /** `baseline_tokens - response_tokens`, floored per call at zero. */
  tokens_saved: number;
  /** Share of the baseline given back, 1 decimal. */
  reduction_pct: number;
  /** `tokens_saved` at {@link price_per_mtok_usd}. */
  usd_saved_floor: number;
  price_model: string;
  price_per_mtok_usd: number;
  /** 'detected' when resolved from user sessions/analytics, or 'fallback' when defaulting to haiku */
  model_source: 'detected' | 'fallback';
  /** ISO date of the first recorded session, or null when the store is empty. */
  since: string | null;
  /** Why the baseline is an estimate and the dollars are a floor. */
  methodology_url: string;
  /** Set when `enough_data` is false — the sentence to show instead of a number. */
  reason?: string;
}

/**
 * Resolves standard published input token price in USD per million tokens for a model.
 * Returns null if the model is unrecognized.
 */
export function resolveModelInputPrice(model: string): number | null {
  if (!model || typeof model !== 'string') return null;
  const m = model.toLowerCase().trim();
  // Claude Opus models ($5.00 / Mtok)
  if (m.includes('opus')) return 5.0;
  // Claude Sonnet models ($3.00 / Mtok)
  if (m.includes('sonnet')) return 3.0;
  // Claude Fable ($3.00 / Mtok)
  if (m.includes('fable')) return 3.0;
  // Claude Haiku models ($1.00 / Mtok)
  if (m.includes('haiku')) return 1.0;
  // OpenAI mini
  if (m.includes('gpt-4o-mini')) return 0.15;
  // OpenAI 4o / 4.5
  if (m.includes('gpt-4o')) return 2.5;
  if (m.includes('gpt-4.5')) return 75.0;
  // OpenAI reasoning
  if (m.includes('o3-mini') || m.includes('o1-mini')) return 1.1;
  if (m.includes('o1') || m.includes('o3')) return 15.0;
  // DeepSeek
  if (m.includes('deepseek-r1') || m.includes('deepseek-reasoner')) return 0.55;
  if (m.includes('deepseek')) return 0.27;
  // Gemini
  if (m.includes('gemini') && m.includes('flash')) return 0.075;
  if (m.includes('gemini') && m.includes('pro')) return 1.25;
  // GLM
  if (m.includes('glm') && m.includes('flash')) return 0.1;
  if (m.includes('glm')) return 1.0;

  return null;
}

/**
 * Detect the active LLM model used by this install, pulling from recent sessions/tool calls
 * in analytics.db, environment overrides, or falling back to the cheapest floor.
 */
export function detectActiveModel(options?: {
  dbPath?: string;
  envModel?: string;
}): DetectedModelInfo {
  // 1. Explicit env override or parameter
  const envModel = options?.envModel ?? process.env.TRACE_SAVINGS_MODEL ?? process.env.TRACE_MODEL;
  if (envModel && envModel.trim().length > 0) {
    const trimmed = envModel.trim();
    const price = resolveModelInputPrice(trimmed) ?? FLOOR_PRICE_PER_MTOK_USD;
    return { model: trimmed, price_per_mtok_usd: price, source: 'detected' };
  }

  // 2. Vitest isolation: do not read host analytics.db unless explicitly passed dbPath
  if (!options?.dbPath && process.env.VITEST) {
    return {
      model: FLOOR_PRICE_MODEL,
      price_per_mtok_usd: FLOOR_PRICE_PER_MTOK_USD,
      source: 'fallback',
    };
  }

  // 3. Search analytics.db
  const candidates: string[] = [];
  if (options?.dbPath) {
    candidates.push(options.dbPath);
  } else {
    candidates.push(path.join(TRACE_MCP_HOME, 'analytics.db'));
    const homedir = os.homedir();
    const altHome = path.join(homedir, '.trace', 'analytics.db');
    if (!candidates.includes(altHome)) candidates.push(altHome);
    try {
      const userInfo = os.userInfo();
      if (userInfo.username) {
        const userHomeDb = path.join(
          process.platform === 'darwin' ? '/Users' : '/home',
          userInfo.username,
          '.trace',
          'analytics.db',
        );
        if (!candidates.includes(userHomeDb)) candidates.push(userHomeDb);
      }
    } catch {
      // ignore
    }
  }

  for (const dbCandidate of candidates) {
    let db: Database.Database | undefined;
    try {
      if (!fs.existsSync(dbCandidate)) continue;
      db = new Database(dbCandidate, { readonly: true, fileMustExist: true });
      // Most active model from recent 50 sessions
      const sessionRow = db
        .prepare(
          `SELECT model, COUNT(*) as cnt
           FROM (
             SELECT model FROM sessions
             WHERE model IS NOT NULL AND length(model) > 0
             ORDER BY started_at DESC LIMIT 50
           )
           GROUP BY model
           ORDER BY cnt DESC
           LIMIT 1`,
        )
        .get() as { model?: string } | undefined;

      if (sessionRow?.model) {
        const price = resolveModelInputPrice(sessionRow.model) ?? FLOOR_PRICE_PER_MTOK_USD;
        return { model: sessionRow.model, price_per_mtok_usd: price, source: 'detected' };
      }

      // Fallback: top model from tool_calls
      const tcRow = db
        .prepare(
          `SELECT model, COUNT(*) as cnt
           FROM tool_calls
           WHERE model IS NOT NULL AND length(model) > 0
           GROUP BY model
           ORDER BY cnt DESC
           LIMIT 1`,
        )
        .get() as { model?: string } | undefined;

      if (tcRow?.model) {
        const price = resolveModelInputPrice(tcRow.model) ?? FLOOR_PRICE_PER_MTOK_USD;
        return { model: tcRow.model, price_per_mtok_usd: price, source: 'detected' };
      }
    } catch {
      // ignore read error and try next
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  return {
    model: FLOOR_PRICE_MODEL,
    price_per_mtok_usd: FLOOR_PRICE_PER_MTOK_USD,
    source: 'fallback',
  };
}

/**
 * Build the report from a persistent store. Pass `null`/omit to read
 * `~/.trace/savings.json`.
 */
export function buildSavingsReport(
  store: PersistentSavings | null = loadPersistentSavings(),
  options?: BuildSavingsReportOptions,
): SavingsReport {
  const measured: MeasuredSavings = store?.measured ?? {
    calls: 0,
    tokens_saved: 0,
    raw_tokens: 0,
    actual_tokens: 0,
  };
  const totalCalls = store?.total_calls ?? 0;
  const modelInfo =
    options?.modelInfo ??
    detectActiveModel({ dbPath: options?.analyticsDbPath, envModel: options?.envModel });

  const priceModel = modelInfo.model;
  const pricePerMtok = modelInfo.price_per_mtok_usd;
  const modelSource = modelInfo.source;

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
    usd_saved_floor: Math.round((measured.tokens_saved / 1_000_000) * pricePerMtok * 100) / 100,
    price_model: priceModel,
    price_per_mtok_usd: pricePerMtok,
    model_source: modelSource,
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
  const priceExplanation =
    r.model_source === 'detected'
      ? `"At least": dollars priced at detected ${r.price_model} ($${r.price_per_mtok_usd.toFixed(2)}/Mtok input)`
      : `"At least": dollars priced at ${r.price_model} ($${r.price_per_mtok_usd.toFixed(2)}/Mtok input), the cheapest current rate`;

  return [
    `Token savings${since}: at least ${fmt(r.tokens_saved)} input tokens (~$${r.usd_saved_floor.toFixed(2)})`,
    `  ${fmt(r.calls)} measured tool calls: ${fmt(r.response_tokens)} tokens returned against a ${fmt(r.baseline_tokens)}-token file-reading baseline — ${r.reduction_pct}% less.`,
    `  ${priceExplanation}; baseline is estimated, responses use chars/4 (~0.25 tokens/char; harness ratio spread 0.220–0.368).`,
    r.unmeasured_calls > 0
      ? `  ${fmt(r.unmeasured_calls)} calls are excluded — recorded before their responses were measured.`
      : null,
    `  Method: ${r.methodology_url}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}
