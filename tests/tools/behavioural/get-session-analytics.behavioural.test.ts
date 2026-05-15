/**
 * Behavioural coverage for `getSessionAnalytics()` — the engine behind the
 * `get_session_analytics` MCP tool.
 *
 * IMPL: src/analytics/session-analytics.ts
 *
 * The tool calls `getSessionAnalytics(analyticsStore, { period, sessionId,
 * projectPath })`. The function first runs `syncAnalytics()` to absorb any
 * fresh session files from disk, then aggregates the AnalyticsStore SQLite
 * DB into a typed envelope. We mock `listAllSessions` to return [] so the
 * sync pass is a no-op; the test then writes ParsedSession rows directly
 * into a tmpDir AnalyticsStore and verifies the aggregation contract.
 *
 * Cases:
 *  - returns envelope { period, sessionsCount, totals, byToolServer,
 *    topTools, topFiles, modelsUsed } when data is seeded
 *  - period='today'|'week'|'all' affects which sessions are counted
 *  - session_id filter narrows to one session and tags period as
 *    'session:<id>'
 *  - empty data returns zero counters
 *  - tool / file entries carry the documented shape
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsStore } from '../../../src/analytics/analytics-store.js';
import type { ParsedSession } from '../../../src/analytics/log-parser.js';
import { createTmpDir, removeTmpDir } from '../../test-utils.js';

// Mock listAllSessions to return [] so syncAnalytics() inside
// getSessionAnalytics() touches no disk state.
vi.mock('../../../src/analytics/log-parser.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/analytics/log-parser.js')>(
    '../../../src/analytics/log-parser.js',
  );
  return {
    ...actual,
    listAllSessions: () => [],
  };
});

import { getSessionAnalytics } from '../../../src/analytics/session-analytics.js';

interface SeedSessionOpts {
  id: string;
  projectPath: string;
  startedAt: string;
  endedAt?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: Array<{
    toolId: string;
    toolName: string;
    toolServer: string;
    toolShortName: string;
    targetFile?: string;
    outputSizeChars?: number;
  }>;
}

function seedSession(store: AnalyticsStore, opts: SeedSessionOpts): void {
  const parsed: ParsedSession = {
    summary: {
      sessionId: opts.id,
      projectPath: opts.projectPath,
      startedAt: opts.startedAt,
      endedAt: opts.endedAt ?? opts.startedAt,
      model: opts.model ?? 'claude-opus-4',
      usage: {
        inputTokens: opts.inputTokens ?? 1000,
        outputTokens: opts.outputTokens ?? 500,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
      toolCallCount: opts.toolCalls?.length ?? 0,
    },
    toolCalls: (opts.toolCalls ?? []).map((tc, i) => ({
      toolId: tc.toolId,
      sessionId: opts.id,
      timestamp: new Date(Date.parse(opts.startedAt) + i * 1000).toISOString(),
      model: opts.model ?? 'claude-opus-4',
      toolName: tc.toolName,
      toolServer: tc.toolServer,
      toolShortName: tc.toolShortName,
      inputParams: {},
      inputSizeChars: 100,
      targetFile: tc.targetFile,
    })),
    toolResults: new Map(
      (opts.toolCalls ?? []).map((tc) => [
        tc.toolId,
        { toolId: tc.toolId, outputSizeChars: tc.outputSizeChars ?? 500, isError: false },
      ]),
    ),
  };
  store.storeSession(parsed);
}

describe('getSessionAnalytics() — behavioural contract', () => {
  let tmpDir: string;
  let store: AnalyticsStore;
  const PROJECT = '/projects/analytics-fixture';

  beforeEach(() => {
    tmpDir = createTmpDir('session-analytics-behav-');
    store = new AnalyticsStore(path.join(tmpDir, 'analytics.db'));
  });

  afterEach(() => {
    store.close();
    if (tmpDir) removeTmpDir(tmpDir);
  });

  it('returns the documented envelope when sessions are seeded', () => {
    seedSession(store, {
      id: 'sess-a',
      projectPath: PROJECT,
      startedAt: new Date().toISOString(),
      inputTokens: 2000,
      outputTokens: 800,
      toolCalls: [
        {
          toolId: 't1',
          toolName: 'Read',
          toolServer: 'builtin',
          toolShortName: 'Read',
          targetFile: 'src/a.ts',
          outputSizeChars: 1200,
        },
        {
          toolId: 't2',
          toolName: 'mcp__trace_mcp__search',
          toolServer: 'trace_mcp',
          toolShortName: 'search',
          outputSizeChars: 400,
        },
      ],
    });

    const result = getSessionAnalytics(store, { period: 'week', projectPath: PROJECT });

    // Spot-check every advertised top-level key.
    expect(Object.keys(result).sort()).toEqual(
      [
        'byToolServer',
        'modelsUsed',
        'period',
        'sessionsCount',
        'topFiles',
        'topTools',
        'totals',
      ].sort(),
    );
    expect(result.period).toBe('week');
    expect(result.sessionsCount).toBe(1);
    expect(result.totals.inputTokens).toBe(2000);
    expect(result.totals.outputTokens).toBe(800);
    expect(result.totals.toolCalls).toBe(2);
    expect(result.totals.estimatedCostUsd).toBeGreaterThan(0);

    expect(result.byToolServer.builtin?.calls).toBe(1);
    expect(result.byToolServer.trace_mcp?.calls).toBe(1);

    expect(Array.isArray(result.topTools)).toBe(true);
    expect(result.topTools.length).toBeGreaterThan(0);
    expect(Array.isArray(result.topFiles)).toBe(true);
    expect(result.topFiles[0]?.path).toBe('src/a.ts');
    expect(result.topFiles[0]?.reads).toBe(1);

    expect(result.modelsUsed['claude-opus-4']).toBeTruthy();
  });

  it("period='today' includes sessions from today; older sessions are excluded", () => {
    const now = new Date();
    const today = now.toISOString();
    // 40 days ago — older than 'month', well outside 'today'/'week'.
    const ancient = new Date(now.getTime() - 40 * 86_400_000).toISOString();

    seedSession(store, {
      id: 'sess-today',
      projectPath: PROJECT,
      startedAt: today,
    });
    seedSession(store, {
      id: 'sess-ancient',
      projectPath: PROJECT,
      startedAt: ancient,
    });

    const todayResult = getSessionAnalytics(store, { period: 'today', projectPath: PROJECT });
    expect(todayResult.sessionsCount).toBe(1);

    const allResult = getSessionAnalytics(store, { period: 'all', projectPath: PROJECT });
    expect(allResult.sessionsCount).toBe(2);
  });

  it('session_id filter narrows to one session and tags period as session:<id>', () => {
    seedSession(store, {
      id: 'sess-one',
      projectPath: PROJECT,
      startedAt: new Date().toISOString(),
      inputTokens: 100,
    });
    seedSession(store, {
      id: 'sess-two',
      projectPath: PROJECT,
      startedAt: new Date().toISOString(),
      inputTokens: 999,
    });

    const result = getSessionAnalytics(store, {
      sessionId: 'sess-one',
      projectPath: PROJECT,
    });
    expect(result.period).toBe('session:sess-one');
    expect(result.sessionsCount).toBe(1);
    expect(result.totals.inputTokens).toBe(100);
  });

  it('empty data returns zero counters', () => {
    const result = getSessionAnalytics(store, { period: 'all', projectPath: PROJECT });
    expect(result.sessionsCount).toBe(0);
    expect(result.totals.inputTokens).toBe(0);
    expect(result.totals.outputTokens).toBe(0);
    expect(result.totals.toolCalls).toBe(0);
    expect(result.totals.estimatedCostUsd).toBe(0);
    expect(result.byToolServer).toEqual({});
    expect(result.topTools).toEqual([]);
    expect(result.topFiles).toEqual([]);
    expect(result.modelsUsed).toEqual({});
  });

  it('top-tool entries carry { name, calls, outputTokensEst }', () => {
    seedSession(store, {
      id: 'sess-shape',
      projectPath: PROJECT,
      startedAt: new Date().toISOString(),
      toolCalls: [
        {
          toolId: 't1',
          toolName: 'Bash',
          toolServer: 'builtin',
          toolShortName: 'Bash',
          outputSizeChars: 2000,
        },
      ],
    });

    const result = getSessionAnalytics(store, { period: 'week', projectPath: PROJECT });
    const t = result.topTools[0];
    expect(t).toBeTruthy();
    expect(typeof t.name).toBe('string');
    expect(typeof t.calls).toBe('number');
    expect(typeof t.outputTokensEst).toBe('number');
    expect(t.name).toBe('Bash');
    expect(t.calls).toBe(1);
  });
});
