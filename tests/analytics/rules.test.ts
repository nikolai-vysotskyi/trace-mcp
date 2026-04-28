import { describe, expect, it } from 'vitest';
import type { ToolCallRow } from '../../src/analytics/analytics-store.js';
import { analyzeOptimizations } from '../../src/analytics/rules.js';

function makeToolCall(overrides: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    tool_name: 'Read',
    tool_server: 'builtin',
    tool_short_name: 'Read',
    output_size_chars: 1000,
    output_tokens_estimate: 286, // ~1000/3.5
    target_file: 'src/foo.ts',
    is_error: 0,
    session_id: 'sess-001',
    input_snippet: null,
    ...overrides,
  };
}

describe('rules / analyzeOptimizations', () => {
  it('returns empty optimizations for empty tool calls', () => {
    const report = analyzeOptimizations([], 'all');
    expect(report.optimizations).toEqual([]);
    expect(report.totalPotentialSavings.tokens).toBe(0);
    expect(report.period).toBe('all');
  });

  describe('repeated-file-read rule', () => {
    it('detects same file read 3+ times in one session', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({ target_file: 'src/big.ts', output_tokens_estimate: 500 }),
        makeToolCall({ target_file: 'src/big.ts', output_tokens_estimate: 500 }),
        makeToolCall({ target_file: 'src/big.ts', output_tokens_estimate: 500 }),
      ];

      const report = analyzeOptimizations(calls, 'week');
      const hit = report.optimizations.find((o) => o.rule === 'repeated-file-read');
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('high');
      expect(hit!.occurrences).toBe(3);
      expect(hit!.currentTokens).toBe(1500);
      expect(hit!.potentialTokens).toBe(300); // 20% of 1500
    });

    it('does not trigger for only 2 reads of same file', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({ target_file: 'src/small.ts' }),
        makeToolCall({ target_file: 'src/small.ts' }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'repeated-file-read');
      expect(hit).toBeUndefined();
    });
  });

  describe('bash-grep rule', () => {
    it('detects Bash calls with grep/rg commands', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          tool_server: 'builtin',
          target_file: null,
          input_snippet: 'grep -r "parseToolName" src/',
          output_tokens_estimate: 1000,
        }),
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          tool_server: 'builtin',
          target_file: null,
          input_snippet: 'rg "function" --type ts',
          output_tokens_estimate: 800,
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'bash-grep');
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('high');
      expect(hit!.occurrences).toBe(2);
      expect(hit!.currentTokens).toBe(1800);
    });

    it('does not trigger for Bash calls without grep', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          tool_name: 'Bash',
          tool_short_name: 'Bash',
          input_snippet: 'npm test',
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'bash-grep');
      expect(hit).toBeUndefined();
    });
  });

  describe('large-file-read rule', () => {
    it('detects Read with output > 5000 chars', () => {
      const calls: ToolCallRow[] = [
        makeToolCall({
          output_size_chars: 8000,
          output_tokens_estimate: 2286,
          target_file: 'src/huge-file.ts',
        }),
        makeToolCall({
          output_size_chars: 6000,
          output_tokens_estimate: 1714,
          target_file: 'src/another-big.ts',
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'large-file-read');
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('medium');
      expect(hit!.occurrences).toBe(2);
      expect(hit!.currentTokens).toBe(4000);
      expect(hit!.potentialTokens).toBe(600); // 15% of 4000
    });

    it('does not trigger for small file reads', () => {
      const calls: ToolCallRow[] = [makeToolCall({ output_size_chars: 2000 })];

      const report = analyzeOptimizations(calls, 'all');
      const hit = report.optimizations.find((o) => o.rule === 'large-file-read');
      expect(hit).toBeUndefined();
    });
  });

  describe('report structure', () => {
    it('has correct structure with period and current usage', () => {
      const calls: ToolCallRow[] = [makeToolCall({ output_tokens_estimate: 500 })];

      const report = analyzeOptimizations(calls, 'month');
      expect(report.period).toBe('month');
      expect(report.currentUsage.totalTokens).toBe(500);
      expect(report.currentUsage.estimatedCostUsd).toBeGreaterThanOrEqual(0);
      expect(report.totalPotentialSavings).toHaveProperty('tokens');
      expect(report.totalPotentialSavings).toHaveProperty('costUsd');
      expect(report.totalPotentialSavings).toHaveProperty('pct');
    });

    it('sorts optimizations by severity (high first)', () => {
      // Create calls that trigger both high (repeated-file-read) and medium (large-file-read) rules
      const calls: ToolCallRow[] = [
        // repeated-file-read (high)
        makeToolCall({ target_file: 'src/x.ts', output_tokens_estimate: 500 }),
        makeToolCall({ target_file: 'src/x.ts', output_tokens_estimate: 500 }),
        makeToolCall({ target_file: 'src/x.ts', output_tokens_estimate: 500 }),
        // large-file-read (medium)
        makeToolCall({
          target_file: 'src/big.ts',
          output_size_chars: 10000,
          output_tokens_estimate: 2857,
        }),
      ];

      const report = analyzeOptimizations(calls, 'all');
      expect(report.optimizations.length).toBeGreaterThanOrEqual(2);

      const severities = report.optimizations.map((o) => o.severity);
      const highIdx = severities.indexOf('high');
      const mediumIdx = severities.indexOf('medium');
      if (highIdx >= 0 && mediumIdx >= 0) {
        expect(highIdx).toBeLessThan(mediumIdx);
      }
    });
  });
});
