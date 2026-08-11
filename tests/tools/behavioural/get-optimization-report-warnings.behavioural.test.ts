/**
 * TRA-76 coverage for `getOptimizationReport()` (src/analytics/session-analytics.ts)
 * — the "_warnings" signal it attaches when no session data is discoverable
 * on disk AND the aggregated tool-call rows are empty. Companion to
 * get-optimization-report.behavioural.test.ts, which covers the pure
 * `analyzeOptimizations()` engine only.
 *
 * Same FS-mocking approach as get-session-analytics.behavioural.test.ts:
 * mock listAllSessions to [] so the internal sync pass is a no-op, then seed
 * (or don't seed) the store directly.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsStore } from '../../../src/analytics/analytics-store.js';
import type { ParsedSession } from '../../../src/analytics/log-parser.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

vi.mock('../../../src/analytics/log-parser.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/analytics/log-parser.js')>(
    '../../../src/analytics/log-parser.js',
  );
  return {
    ...actual,
    listAllSessions: () => [],
  };
});

import { getOptimizationReport } from '../../../src/analytics/session-analytics.js';

const PROJECT = '/projects/optimization-report-fixture';

function seedSessionWithReads(store: AnalyticsStore): void {
  const parsed: ParsedSession = {
    summary: {
      sessionId: 'sess-a',
      projectPath: PROJECT,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      model: 'claude-opus-4',
      usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreateTokens: 0 },
      toolCallCount: 3,
    },
    toolCalls: ['t1', 't2', 't3'].map((id, i) => ({
      toolId: id,
      sessionId: 'sess-a',
      timestamp: new Date(Date.now() + i * 1000).toISOString(),
      model: 'claude-opus-4',
      toolName: 'Read',
      toolServer: 'builtin',
      toolShortName: 'Read',
      inputParams: {},
      inputSizeChars: 100,
      targetFile: 'src/foo.ts',
    })),
    toolResults: new Map(
      ['t1', 't2', 't3'].map((id) => [id, { toolId: id, outputSizeChars: 1200, isError: false }]),
    ),
  };
  store.storeSession(parsed);
}

describe('getOptimizationReport() — TRA-76 _warnings contract', () => {
  let tmpDir: string;
  let store: AnalyticsStore;

  beforeEach(() => {
    tmpDir = createTmpDir('optimization-report-warnings-');
    store = new AnalyticsStore(path.join(tmpDir, 'analytics.db'));
  });

  afterEach(() => {
    store.close();
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('attaches _warnings when zero tool calls found and no session files on disk', () => {
    const report = getOptimizationReport(store, { period: 'all', projectPath: PROJECT });
    expect(report.optimizations).toEqual([]);
    expect(report._warnings).toBeDefined();
    expect(report._warnings?.[0]).toContain(PROJECT);
  });

  it('does not attach _warnings when there is real tool-call data', () => {
    seedSessionWithReads(store);
    const report = getOptimizationReport(store, { period: 'all', projectPath: PROJECT });
    expect(report._warnings).toBeUndefined();
  });
});
