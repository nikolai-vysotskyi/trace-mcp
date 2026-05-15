/**
 * Behavioural coverage for the `get_real_savings` MCP tool.
 *
 * IMPL NOTE: `get_real_savings` is inline-registered in
 * `src/tools/register/session.ts` (lines 404-437). The wrapper:
 *   1. opens an AnalyticsStore (hits ~/.trace-mcp/analytics.db on disk)
 *   2. calls `syncAnalytics()` which scans ~/.claude/projects on the FS
 *   3. fetches ToolCallRow[] via `getToolCallsForOptimization`
 *   4. forwards to the pure function `analyzeRealSavings(store, toolCalls, period)`
 *
 * The FS-bound sync step is hard to mock without touching the user's
 * Claude Code log directory, so we test the deterministic pure engine with
 * synthetic ToolCallRow fixtures and an in-memory Store (same approach as
 * `get-optimization-report.behavioural.test.ts`).
 *
 * Contract under test:
 *   - empty toolCalls → zero summary + empty byFile + empty byToolReplaced
 *   - period parameter is echoed verbatim on the report
 *   - file-read events get an alternative when the file IS in the index
 *   - file-read events count toward filesNotIndexed when the file isn't indexed
 *   - per-file entries have stable shape (reads, totalReadTokens, alt, savingsPct)
 */
import { describe, expect, it } from 'vitest';
import type { ToolCallRow } from '../../../src/analytics/analytics-store.js';
import { analyzeRealSavings } from '../../../src/analytics/real-savings.js';
import { createTestStore } from '../../test-utils.js';

function readCall(file: string, session = 's1', outputChars = 2000): ToolCallRow {
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

describe('get_real_savings — analyzeRealSavings() behavioural contract', () => {
  it('empty events return zero summary + empty file/tool breakdowns', () => {
    const store = createTestStore();
    const report = analyzeRealSavings(store, [], 'week');
    expect(report.period).toBe('week');
    expect(report.sessionsAnalyzed).toBe(0);
    expect(report.fileReadsAnalyzed).toBe(0);
    expect(report.filesInIndex).toBe(0);
    expect(report.filesNotIndexed).toBe(0);
    expect(report.byFile).toEqual([]);
    expect(report.byToolReplaced).toEqual({});
    expect(report.summary.totalReadTokens).toBe(0);
    expect(report.summary.achievableWithTraceMcp).toBe(0);
    expect(report.summary.potentialSavingsTokens).toBe(0);
    expect(report.summary.potentialSavingsPct).toBe(0);
  });

  it('the `period` argument is echoed on the report envelope', () => {
    const store = createTestStore();
    for (const period of ['today', 'week', 'month', 'all'] as const) {
      const report = analyzeRealSavings(store, [], period);
      expect(report.period).toBe(period);
    }
  });

  it('reads of files NOT in the index count as filesNotIndexed (no savings)', () => {
    const store = createTestStore();
    const calls = [readCall('src/never-indexed.ts'), readCall('src/never-indexed.ts')];
    const report = analyzeRealSavings(store, calls, 'week');
    expect(report.fileReadsAnalyzed).toBe(2);
    expect(report.filesInIndex).toBe(0);
    expect(report.filesNotIndexed).toBe(1);
    expect(report.byFile).toEqual([]);
    // Tool bucket still records the original calls.
    const readBucket = report.byToolReplaced['Read'];
    expect(readBucket?.calls).toBe(2);
    expect(readBucket?.replaceableCalls).toBe(0);
  });

  it('reads of files IN the index surface a per-file alternative + savings', () => {
    const store = createTestStore();
    // Insert a fake file with a symbol so computeAlternativeTokens has shape.
    const fileId = store.insertFile('src/foo.ts', 'typescript', 8000, '0xabc');
    store.insertSymbol(fileId, {
      name: 'foo',
      kind: 'function',
      fqn: 'src/foo.ts::foo',
      signature: 'foo(x: number): number',
      summary: null,
      byte_start: 0,
      byte_end: 4000,
      line_start: 1,
      line_end: 100,
      visibility: 'public',
      exported: true,
    } as any);

    const calls = [readCall('src/foo.ts'), readCall('src/foo.ts')];
    const report = analyzeRealSavings(store, calls, 'week');
    expect(report.filesInIndex).toBe(1);
    expect(report.filesNotIndexed).toBe(0);
    expect(report.byFile.length).toBe(1);

    const entry = report.byFile[0];
    expect(entry.file).toBe('src/foo.ts');
    expect(entry.reads).toBe(2);
    expect(typeof entry.totalReadTokens).toBe('number');
    expect(typeof entry.alternativeTokens).toBe('number');
    expect(typeof entry.bestAlternative).toBe('string');
    expect(entry.bestAlternative.length).toBeGreaterThan(0);
    expect(typeof entry.savingsPct).toBe('number');
    // Alternative is at most the original (capped).
    expect(entry.alternativeTokens).toBeLessThanOrEqual(entry.totalReadTokens);
  });

  it('summary numbers are internally consistent (savings = total − achievable)', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/a.ts', 'typescript', 6000, '0xa');
    store.insertSymbol(fileId, {
      name: 'a',
      kind: 'function',
      fqn: 'src/a.ts::a',
      signature: 'a()',
      summary: null,
      byte_start: 0,
      byte_end: 3000,
      line_start: 1,
      line_end: 50,
      visibility: 'public',
      exported: true,
    } as any);

    const calls = [readCall('src/a.ts'), readCall('src/a.ts'), readCall('src/a.ts')];
    const report = analyzeRealSavings(store, calls, 'all');

    expect(report.summary.potentialSavingsTokens).toBe(
      report.summary.totalReadTokens - report.summary.achievableWithTraceMcp,
    );
    // Cost savings dict has expected keys.
    const costKeys = Object.keys(report.summary.potentialCostSavings);
    expect(costKeys.length).toBeGreaterThan(0);
    for (const v of Object.values(report.summary.potentialCostSavings)) {
      expect(typeof v).toBe('string');
      expect(v.startsWith('$')).toBe(true);
    }
  });

  it('sessionsAnalyzed counts unique session_id values across read events', () => {
    const store = createTestStore();
    const calls = [
      readCall('src/missing-1.ts', 'session-A'),
      readCall('src/missing-2.ts', 'session-A'),
      readCall('src/missing-3.ts', 'session-B'),
    ];
    const report = analyzeRealSavings(store, calls, 'week');
    expect(report.sessionsAnalyzed).toBe(2);
    expect(report.fileReadsAnalyzed).toBe(3);
  });
});
