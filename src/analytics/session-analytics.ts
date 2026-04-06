import type { AnalyticsStore } from './analytics-store.js';
import { syncAnalytics, syncProjectAnalytics } from './sync.js';
import { analyzeOptimizations, type OptimizationReport } from './rules.js';

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
}

export function getSessionAnalytics(
  store: AnalyticsStore,
  opts: AnalyticsOptions,
): SessionAnalytics {
  if (opts.projectPath) {
    syncProjectAnalytics(store, opts.projectPath);
  } else {
    syncAnalytics(store);
  }

  const period = opts.period ?? 'week';
  const result = store.getSessionAnalytics({
    projectPath: opts.projectPath,
    period: period === 'all' ? 'all' : period,
    sessionId: opts.sessionId,
  });

  return {
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
      Object.entries(result.by_tool_server).map(([k, v]) => [k, {
        calls: v.calls,
        outputTokensEst: v.output_tokens_est,
        pct: v.pct,
      }]),
    ),
    topTools: result.top_tools.map(t => ({
      name: t.name,
      calls: t.calls,
      outputTokensEst: t.output_tokens_est,
    })),
    topFiles: result.top_files.map(f => ({
      path: f.path,
      reads: f.reads,
      tokensEst: f.tokens_est,
    })),
    modelsUsed: result.models_used,
  };
}

export function getOptimizationReport(
  store: AnalyticsStore,
  opts: AnalyticsOptions,
): OptimizationReport {
  if (opts.projectPath) {
    syncProjectAnalytics(store, opts.projectPath);
  } else {
    syncAnalytics(store);
  }

  const period = opts.period ?? 'week';
  const toolCallRows = store.getToolCallsForOptimization({
    projectPath: opts.projectPath,
    period: period === 'all' ? 'all' : period,
    sessionId: opts.sessionId,
  });

  return analyzeOptimizations(toolCallRows, opts.sessionId ? `session:${opts.sessionId}` : period);
}
