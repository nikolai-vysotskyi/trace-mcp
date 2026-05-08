/**
 * Token savings tracker — session + persistent cumulative stats.
 *
 * Session stats track per-tool call counts and estimated token savings.
 * Persistent stats accumulate across sessions in ~/.trace-mcp/savings.json.
 *
 * Token estimation: we estimate how many tokens a raw Read/Grep would cost
 * vs the compact response trace-mcp returns. The ratio depends on the tool.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureGlobalDirs, TRACE_MCP_HOME } from './global.js';
import { logger } from './logger.js';
import { atomicWriteJson } from './utils/atomic-write.js';

export const SAVINGS_PATH = path.join(TRACE_MCP_HOME, 'savings.json');

/** Estimated raw-token cost for common operations (what you'd pay without trace-mcp) */
const RAW_COST_ESTIMATES: Record<string, number> = {
  get_symbol: 800,
  search: 600,
  search_text: 3000,
  get_outline: 1200,
  get_change_impact: 2000,
  get_feature_context: 4000,
  get_task_context: 8000,
  get_context_bundle: 6000,
  get_call_graph: 1500,
  find_usages: 1000,
  get_tests_for: 800,
  get_request_flow: 1200,
  get_component_tree: 2000,
  get_model_context: 1000,
  get_event_graph: 800,
  get_project_map: 1500,
  suggest_queries: 400,
  get_related_symbols: 600,
  get_dead_code: 1200,
  get_complexity_report: 800,
  get_coupling: 600,
  get_circular_imports: 500,
  graph_query: 2000,
  predict_bugs: 1000,
  get_tech_debt: 1200,
  assess_change_risk: 800,
  get_project_health: 3000,
  self_audit: 2000,
};

/** Default raw cost for tools not in the map */
const DEFAULT_RAW_COST = 500;

/** Estimated compression ratio (trace-mcp response tokens / raw tokens) */
const COMPRESSION_RATIO = 0.15;

interface ToolCallRecord {
  calls: number;
  tokens_saved: number;
  raw_tokens: number;
}

/**
 * Latency stats for a tool, computed on demand from a bounded ring buffer of
 * recent durations. Bounded so a long-running session doesn't grow without limit.
 */
export interface ToolLatencyStats {
  p50: number;
  p95: number;
  max: number;
  count: number;
  errors: number;
  error_rate: number;
  /** Window size — number of most-recent calls actually retained. */
  window: number;
}

/** Max retained durations per tool. p95 stays meaningful at this size. */
const LATENCY_WINDOW = 200;

interface ToolLatencyState {
  /** Bounded ring of recent durations in ms. */
  durations: number[];
  /** Total calls (incl. those rolled out of the ring). */
  totalCalls: number;
  /** Total errors (incl. those rolled out of the ring). */
  totalErrors: number;
}

interface SessionStats {
  started_at: string;
  total_calls: number;
  total_tokens_saved: number;
  total_raw_tokens: number;
  total_actual_tokens: number;
  per_tool: Record<string, ToolCallRecord>;
}

interface PersistentSavings {
  version: 1;
  total_tokens_saved: number;
  total_raw_tokens: number;
  total_calls: number;
  sessions: number;
  first_session: string;
  last_session: string;
  per_project: Record<
    string,
    {
      tokens_saved: number;
      calls: number;
      last_used: string;
    }
  >;
  per_tool: Record<
    string,
    {
      calls: number;
      tokens_saved: number;
    }
  >;
}

/** Minimal sink interface — kept anemic so {@link SavingsTracker} doesn't pull in better-sqlite3
 *  for tests and callers that don't enable telemetry persistence. */
export interface LatencySink {
  recordCall(toolName: string, durationMs: number, isError: boolean, ts?: number): void;
}

export class SavingsTracker {
  private session: SessionStats;
  private projectRoot: string;
  private flushed = false;
  /** Per-tool latency state. Kept separate from per_tool savings so tokens-related logic
   *  doesn't have to deal with timing concerns. */
  private latency: Record<string, ToolLatencyState> = {};
  /** Optional persistent sink for cross-session analysis. Only attached when telemetry is on. */
  private sink: LatencySink | null = null;

  constructor(projectRoot: string, sink: LatencySink | null = null) {
    this.projectRoot = projectRoot;
    this.sink = sink;
    this.session = {
      started_at: new Date().toISOString(),
      total_calls: 0,
      total_tokens_saved: 0,
      total_raw_tokens: 0,
      total_actual_tokens: 0,
      per_tool: {},
    };
  }

  /** Record a tool call with an optional actual response token count */
  recordCall(toolName: string, actualTokens?: number): void {
    const rawCost = RAW_COST_ESTIMATES[toolName] ?? DEFAULT_RAW_COST;
    const actual = actualTokens ?? Math.round(rawCost * COMPRESSION_RATIO);
    const saved = Math.max(0, rawCost - actual);

    this.session.total_calls++;
    this.session.total_raw_tokens += rawCost;
    this.session.total_actual_tokens += actual;
    this.session.total_tokens_saved += saved;

    const rec = (this.session.per_tool[toolName] ??= { calls: 0, tokens_saved: 0, raw_tokens: 0 });
    rec.calls++;
    rec.tokens_saved += saved;
    rec.raw_tokens += rawCost;
  }

  /**
   * Record the latency (wall-clock ms) and outcome of a tool call.
   * Independent from {@link recordCall} so callers can record one without the other
   * (e.g. an early validation failure doesn't have a meaningful token cost).
   */
  recordLatency(toolName: string, durationMs: number, isError = false): void {
    const state = (this.latency[toolName] ??= { durations: [], totalCalls: 0, totalErrors: 0 });
    state.totalCalls += 1;
    if (isError) state.totalErrors += 1;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      state.durations.push(durationMs);
      if (state.durations.length > LATENCY_WINDOW) {
        state.durations.shift();
      }
    }
    if (this.sink) {
      this.sink.recordCall(toolName, durationMs, isError);
    }
  }

  /** Get latency stats for a single tool, or null if no calls have been recorded. */
  getLatencyStats(toolName: string): ToolLatencyStats | null {
    const state = this.latency[toolName];
    if (!state || state.totalCalls === 0) return null;
    return computeLatencyStats(state);
  }

  /** Get latency stats for every tool with at least one recorded call. */
  getLatencyPerTool(): Record<string, ToolLatencyStats> {
    const out: Record<string, ToolLatencyStats> = {};
    for (const [tool, state] of Object.entries(this.latency)) {
      if (state.totalCalls > 0) out[tool] = computeLatencyStats(state);
    }
    return out;
  }

  /** Get current session stats */
  getSessionStats(): SessionStats & {
    reduction_pct: number;
    latency_per_tool: Record<string, ToolLatencyStats>;
  } {
    const reduction =
      this.session.total_raw_tokens > 0
        ? Math.round((this.session.total_tokens_saved / this.session.total_raw_tokens) * 100)
        : 0;
    return {
      ...this.session,
      reduction_pct: reduction,
      latency_per_tool: this.getLatencyPerTool(),
    };
  }

  /** Get combined session + cumulative stats */
  getFullStats(): {
    session: SessionStats & { reduction_pct: number };
    cumulative: PersistentSavings | null;
  } {
    return {
      session: this.getSessionStats(),
      cumulative: loadPersistentSavings(),
    };
  }

  /** Flush session stats to persistent file. Call on shutdown. Idempotent. */
  flush(): void {
    if (this.flushed || this.session.total_calls === 0) return;
    this.flushed = true;

    try {
      ensureGlobalDirs();
      const existing = loadPersistentSavings();
      const now = new Date().toISOString();

      const merged: PersistentSavings = existing ?? {
        version: 1,
        total_tokens_saved: 0,
        total_raw_tokens: 0,
        total_calls: 0,
        sessions: 0,
        first_session: now,
        last_session: now,
        per_project: {},
        per_tool: {},
      };

      merged.total_tokens_saved += this.session.total_tokens_saved;
      merged.total_raw_tokens += this.session.total_raw_tokens;
      merged.total_calls += this.session.total_calls;
      merged.sessions++;
      merged.last_session = now;

      // Per-project
      const projKey = this.projectRoot;
      const proj = (merged.per_project[projKey] ??= { tokens_saved: 0, calls: 0, last_used: now });
      proj.tokens_saved += this.session.total_tokens_saved;
      proj.calls += this.session.total_calls;
      proj.last_used = now;

      // Per-tool
      for (const [tool, rec] of Object.entries(this.session.per_tool)) {
        const t = (merged.per_tool[tool] ??= { calls: 0, tokens_saved: 0 });
        t.calls += rec.calls;
        t.tokens_saved += rec.tokens_saved;
      }

      savePersistentSavings(merged);
      logger.debug(
        { calls: this.session.total_calls, saved: this.session.total_tokens_saved },
        'Session savings flushed',
      );
    } catch (e) {
      logger.warn({ error: e }, 'Failed to flush savings to disk');
    }
  }
}

/** Load persistent savings from disk. Returns null if none. */
export function loadPersistentSavings(): PersistentSavings | null {
  try {
    if (!fs.existsSync(SAVINGS_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(SAVINGS_PATH, 'utf-8'));
    if (raw.version !== 1) return null;
    return raw as PersistentSavings;
  } catch {
    return null;
  }
}

function savePersistentSavings(data: PersistentSavings): void {
  atomicWriteJson(SAVINGS_PATH, data);
}

/**
 * Compute p50/p95/max from a duration ring. Sorts a copy so the live ring isn't
 * disturbed; ring is bounded so the sort is cheap.
 */
function computeLatencyStats(state: ToolLatencyState): ToolLatencyStats {
  const durations = state.durations;
  if (durations.length === 0) {
    return {
      p50: 0,
      p95: 0,
      max: 0,
      count: state.totalCalls,
      errors: state.totalErrors,
      error_rate: state.totalCalls > 0 ? state.totalErrors / state.totalCalls : 0,
      window: 0,
    };
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    count: state.totalCalls,
    errors: state.totalErrors,
    error_rate: state.totalCalls > 0 ? state.totalErrors / state.totalCalls : 0,
    window: durations.length,
  };
}

/** Linear-interp percentile; expects `sorted` ascending and non-empty. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0] ?? 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  const frac = idx - lo;
  return (sorted[lo] ?? 0) * (1 - frac) + (sorted[hi] ?? 0) * frac;
}
