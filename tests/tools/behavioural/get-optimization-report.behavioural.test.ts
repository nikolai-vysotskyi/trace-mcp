/**
 * Behavioural coverage for `analyzeOptimizations()` — the engine behind the
 * `get_optimization_report` MCP tool.
 *
 * IMPL NOTE: `getOptimizationReport()` in `src/analytics/session-analytics.ts`
 * is a thin wrapper that (a) syncs Claude Code logs into the AnalyticsStore
 * via `syncAnalytics`/`syncProjectAnalytics` and (b) calls
 * `analyzeOptimizations(toolCallRows, period)`. The sync step hits the
 * filesystem (~/.claude/projects) and is hard to mock. We test the
 * deterministic pure function with synthetic ToolCallRow fixtures (same
 * approach as `get-env-vars.behavioural.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { ToolCallRow } from '../../../src/analytics/analytics-store.js';
import { analyzeOptimizations } from '../../../src/analytics/rules.js';

function readCall(file: string, session = 's1', outputChars = 1200): ToolCallRow {
  return {
    tool_name: 'Read',
    tool_server: 'builtin',
    tool_short_name: 'Read',
    output_size_chars: outputChars,
    output_tokens_estimate: Math.ceil(outputChars / 3.5),
    target_file: file,
    is_error: 0,
    session_id: session,
    input_snippet: null,
  };
}

describe('analyzeOptimizations() — behavioural contract for get_optimization_report', () => {
  it('seeded duplicate-read events surface the repeated-file-read rule', () => {
    const calls: ToolCallRow[] = [
      readCall('src/foo.ts'),
      readCall('src/foo.ts'),
      readCall('src/foo.ts'),
      readCall('src/bar.ts'),
    ];
    const report = analyzeOptimizations(calls, 'week');
    const rules = report.optimizations.map((o) => o.rule);
    expect(rules).toContain('repeated-file-read');
    const hit = report.optimizations.find((o) => o.rule === 'repeated-file-read')!;
    expect(hit.severity).toBe('high');
    expect(hit.occurrences).toBe(3);
    expect(hit.details.some((d) => d.includes('src/foo.ts'))).toBe(true);
  });

  it('empty events return an empty optimisations list and zero savings', () => {
    const report = analyzeOptimizations([], 'week');
    expect(report.optimizations).toEqual([]);
    expect(report.totalPotentialSavings.tokens).toBe(0);
    expect(report.totalPotentialSavings.pct).toBe(0);
    expect(report.currentUsage.totalTokens).toBe(0);
  });

  it('each optimisation carries rule / severity / recommendation / token counts', () => {
    const calls: ToolCallRow[] = [
      readCall('src/foo.ts'),
      readCall('src/foo.ts'),
      readCall('src/foo.ts'),
    ];
    const report = analyzeOptimizations(calls, 'week');
    expect(report.optimizations.length).toBeGreaterThan(0);
    for (const opt of report.optimizations) {
      expect(typeof opt.rule).toBe('string');
      expect(['high', 'medium', 'low']).toContain(opt.severity);
      expect(typeof opt.recommendation).toBe('string');
      expect(opt.recommendation.length).toBeGreaterThan(0);
      expect(typeof opt.currentTokens).toBe('number');
      expect(typeof opt.potentialTokens).toBe('number');
      expect(opt.occurrences).toBeGreaterThan(0);
    }
  });

  it('totalPotentialSavings.tokens equals sum of per-rule (current − potential)', () => {
    // Compose a workload that triggers two distinct rules: repeated reads
    // (high) + a large-file read (medium). Then check the global sum matches.
    const calls: ToolCallRow[] = [
      readCall('src/repeated.ts'),
      readCall('src/repeated.ts'),
      readCall('src/repeated.ts'),
      readCall('src/huge.ts', 's2', 12_000),
    ];
    const report = analyzeOptimizations(calls, 'week');
    const expectedSum = report.optimizations.reduce(
      (sum, o) => sum + (o.currentTokens - o.potentialTokens),
      0,
    );
    expect(report.totalPotentialSavings.tokens).toBe(expectedSum);
  });
});
