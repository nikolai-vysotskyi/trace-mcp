import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AnalyticsStore } from '../../src/analytics/analytics-store.js';
import type { ParsedSession } from '../../src/analytics/log-parser.js';
import path from 'node:path';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

function makeParsedSession(overrides: Partial<ParsedSession['summary']> = {}): ParsedSession {
  return {
    summary: {
      sessionId: 'sess-1',
      projectPath: '/test/project',
      startedAt: '2026-04-01T10:00:00Z',
      endedAt: '2026-04-01T10:30:00Z',
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheCreateTokens: 100 },
      toolCallCount: 3,
      ...overrides,
    },
    toolCalls: [
      {
        toolId: 'tc-1',
        sessionId: overrides.sessionId ?? 'sess-1',
        timestamp: '2026-04-01T10:05:00Z',
        model: 'claude-sonnet-4-6',
        toolName: 'Read',
        toolServer: 'builtin',
        toolShortName: 'Read',
        inputParams: { file_path: 'src/main.ts' },
        inputSizeChars: 30,
        targetFile: 'src/main.ts',
      },
      {
        toolId: 'tc-2',
        sessionId: overrides.sessionId ?? 'sess-1',
        timestamp: '2026-04-01T10:10:00Z',
        model: 'claude-sonnet-4-6',
        toolName: 'mcp__trace-mcp__search',
        toolServer: 'trace-mcp',
        toolShortName: 'search',
        inputParams: { query: 'handleSubmit' },
        inputSizeChars: 25,
      },
      {
        toolId: 'tc-3',
        sessionId: overrides.sessionId ?? 'sess-1',
        timestamp: '2026-04-01T10:15:00Z',
        model: 'claude-sonnet-4-6',
        toolName: 'Bash',
        toolServer: 'builtin',
        toolShortName: 'Bash',
        inputParams: { command: 'grep -r handleSubmit src/' },
        inputSizeChars: 40,
      },
    ],
    toolResults: new Map([
      ['tc-1', { toolId: 'tc-1', outputSizeChars: 5000, isError: false }],
      ['tc-2', { toolId: 'tc-2', outputSizeChars: 800, isError: false }],
      ['tc-3', { toolId: 'tc-3', outputSizeChars: 2000, isError: false }],
    ]),
  };
}

describe('AnalyticsStore', () => {
  let store: AnalyticsStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = createTmpDir('analytics-store-test-');
    dbPath = path.join(tmpDir, 'test-analytics.db');
    store = new AnalyticsStore(dbPath);
  });

  afterEach(() => {
    store.close();
    removeTmpDir(tmpDir);
  });

  it('stores and retrieves a session', () => {
    const session = makeParsedSession();
    store.storeSession(session);

    const stats = store.getSyncStats();
    expect(stats.sessions).toBe(1);
    expect(stats.tool_calls).toBe(3);
  });

  it('needsSync returns true for new files', () => {
    expect(store.needsSync('/test/file.jsonl', Date.now())).toBe(true);
  });

  it('needsSync returns false after markSynced', () => {
    const mtime = Date.now();
    store.markSynced('/test/file.jsonl', mtime);
    expect(store.needsSync('/test/file.jsonl', mtime)).toBe(false);
  });

  it('needsSync returns true when mtime increased', () => {
    const mtime = Date.now();
    store.markSynced('/test/file.jsonl', mtime);
    expect(store.needsSync('/test/file.jsonl', mtime + 1000)).toBe(true);
  });

  it('getSessionAnalytics returns correct totals', () => {
    store.storeSession(makeParsedSession());

    const result = store.getSessionAnalytics({ period: 'all' });
    expect(result.sessions_count).toBe(1);
    expect(result.totals.input_tokens).toBe(1000);
    expect(result.totals.output_tokens).toBe(200);
    expect(result.totals.tool_calls).toBe(3);
  });

  it('getSessionAnalytics shows tool server breakdown', () => {
    store.storeSession(makeParsedSession());

    const result = store.getSessionAnalytics({ period: 'all' });
    expect(result.by_tool_server).toHaveProperty('builtin');
    expect(result.by_tool_server).toHaveProperty('trace-mcp');
    expect(result.by_tool_server['builtin'].calls).toBe(2); // Read + Bash
    expect(result.by_tool_server['trace-mcp'].calls).toBe(1); // search
  });

  it('getToolCallsForOptimization returns all calls', () => {
    store.storeSession(makeParsedSession());

    const calls = store.getToolCallsForOptimization({ period: 'all' });
    expect(calls).toHaveLength(3);
    expect(calls[0].tool_name).toBe('Read');
  });

  it('upserts session on re-store', () => {
    store.storeSession(makeParsedSession());
    store.storeSession(makeParsedSession()); // re-store

    const stats = store.getSyncStats();
    expect(stats.sessions).toBe(1);
    expect(stats.tool_calls).toBe(3);
  });
});
