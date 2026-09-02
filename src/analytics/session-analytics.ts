import type { AnalyticsStore } from './analytics-store.js';
import { listAllSessions } from './log-parser.js';
import { analyzeOptimizations, type OptimizationReport } from './rules.js';
import {
  attachIngestionStatus,
  attachNoSessionDataWarning,
  type IngestionStatus,
  syncAnalytics,
  syncProjectAnalytics,
} from './sync.js';

export type { OptimizationReport } from './rules.js';

interface AnalyticsOptions {
  period?: 'today' | 'week' | 'month' | 'all';
  sessionId?: string;
  projectPath?: string;
}

interface SessionAnalytics {
  period: string;
  sessionsCount: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    estimatedCostUsd: number;
    toolCalls: number;
  };
  byToolServer: Record<string, { calls: number; outputTokensEst: number; pct: number }>;
  topTools: { name: string; calls: number; outputTokensEst: number }[];
  topFiles: { path: string; reads: number; tokensEst: number }[];
  modelsUsed: Record<string, { sessions: number; tokens: number }>;
  /** Set when zero session data was found both on disk and in the aggregation — see TRA-76. */
  _warnings?: string[];
  /** Ingestion watermark of the analytics DB — see TRA-695. */
  _ingestion?: IngestionStatus;
}

export function getSessionAnalytics(
  store: AnalyticsStore,
  opts: AnalyticsOptions,
): SessionAnalytics {
  const sync = opts.projectPath
    ? syncProjectAnalytics(store, opts.projectPath)
    : syncAnalytics(store);

  const period = opts.period ?? 'week';
  const result = store.getSessionAnalytics({
    projectPath: opts.projectPath,
    period: period === 'all' ? 'all' : period,
    sessionId: opts.sessionId,
  });

  const analytics: SessionAnalytics = {
    period: opts.sessionId ? `session:${opts.sessionId}` : period,
    sessionsCount: result.sessions_count,
    totals: {
      inputTokens: result.totals.input_tokens,
      outputTokens: result.totals.output_tokens,
      cacheReadTokens: result.totals.cache_read_tokens,
      cacheCreateTokens: result.totals.cache_create_tokens,
      estimatedCostUsd: result.totals.estimated_cost_usd,
      toolCalls: result.totals.tool_calls,
    },
    byToolServer: Object.fromEntries(
      Object.entries(result.by_tool_server).map(([k, v]) => [
        k,
        {
          calls: v.calls,
          outputTokensEst: v.output_tokens_est,
          pct: v.pct,
        },
      ]),
    ),
    topTools: result.top_tools.map((t) => ({
      name: t.name,
      calls: t.calls,
      outputTokensEst: t.output_tokens_est,
    })),
    topFiles: result.top_files.map((f) => ({
      path: f.path,
      reads: f.reads,
      tokensEst: f.tokens_est,
    })),
    modelsUsed: result.models_used,
  };

  attachNoSessionDataWarning(
    analytics,
    result.sessions_count === 0,
    listAllSessions(opts.projectPath).length === 0,
    opts.projectPath,
  );
  attachIngestionStatus(analytics, store, sync);

  return analytics;
}

export function getOptimizationReport(
  store: AnalyticsStore,
  opts: AnalyticsOptions,
): OptimizationReport {
  const sync = opts.projectPath
    ? syncProjectAnalytics(store, opts.projectPath)
    : syncAnalytics(store);

  const period = opts.period ?? 'week';
  const toolCallRows = store.getToolCallsForOptimization({
    projectPath: opts.projectPath,
    period: period === 'all' ? 'all' : period,
    sessionId: opts.sessionId,
  });

  const report = analyzeOptimizations(
    toolCallRows,
    opts.sessionId ? `session:${opts.sessionId}` : period,
  );

  attachNoSessionDataWarning(
    report,
    toolCallRows.length === 0,
    listAllSessions(opts.projectPath).length === 0,
    opts.projectPath,
  );
  attachIngestionStatus(report, store, sync);

  return report;
}
