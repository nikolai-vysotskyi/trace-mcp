import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsStore, isTraceToolServer } from '../../src/analytics/analytics-store.js';
import type { ParsedSession } from '../../src/analytics/log-parser.js';
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
      ['tc-1', { toolId: 'tc-1', outputSizeChars: 5000, isError: false, semanticDegraded: false }],
      ['tc-2', { toolId: 'tc-2', outputSizeChars: 800, isError: false, semanticDegraded: false }],
      ['tc-3', { toolId: 'tc-3', outputSizeChars: 2000, isError: false, semanticDegraded: false }],
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
    expect(result.by_tool_server.builtin.calls).toBe(2); // Read + Bash
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

  it('persists semantic_degraded flag from ToolResultEvent through getToolCallsForOptimization', () => {
    const session = makeParsedSession();
    session.toolCalls.push({
      toolId: 'tc-4',
      sessionId: 'sess-1',
      timestamp: '2026-04-01T10:20:00Z',
      model: 'claude-sonnet-4-6',
      toolName: 'mcp__trace-mcp__search',
      toolServer: 'trace-mcp',
      toolShortName: 'search',
      inputParams: { query: 'authenticate user', semantic: 'on' },
      inputSizeChars: 40,
    });
    session.toolResults.set('tc-4', {
      toolId: 'tc-4',
      outputSizeChars: 300,
      isError: false,
      semanticDegraded: true,
    });
    store.storeSession(session);

    const calls = store.getToolCallsForOptimization({ period: 'all' });
    const searchCalls = calls.filter((c) => c.tool_name === 'mcp__trace-mcp__search');
    expect(searchCalls).toHaveLength(2); // base fixture's tc-2 + our pushed tc-4
    const degraded = searchCalls.find((c) => c.input_snippet?.includes('authenticate user'));
    expect(degraded).toBeDefined();
    expect(degraded!.semantic_degraded).toBe(1);

    // The base fixture's search call (no degradation) must read back 0, not NULL/undefined.
    const notDegraded = searchCalls.find((c) => c.input_snippet?.includes('handleSubmit'));
    expect(notDegraded!.semantic_degraded).toBe(0);

    // Non-search rows must also read back 0.
    const readCall = calls.find((c) => c.tool_name === 'Read');
    expect(readCall!.semantic_degraded).toBe(0);
  });

  it('filters tool_calls via an indexed session_id subquery, not a full JOIN scan', () => {
    // Regression guard for the perf fix: getSessionAnalytics/
    // getToolCallsForOptimization used to `JOIN sessions` directly, which
    // made SQLite scan the entire (potentially much larger) tool_calls
    // table with a per-row point-lookup into sessions. Measured ~5-24x
    // slower than the `tc.session_id IN (SELECT id FROM sessions WHERE ...)`
    // form on this project's own analytics DB (75k+ tool_calls rows). Assert
    // the query plan still uses the cheap indexed-search shape so a future
    // edit can't silently reintroduce the JOIN.
    store.storeSession(makeParsedSession());

    const plan = store.db
      .prepare(`
        EXPLAIN QUERY PLAN
        SELECT tc.tool_server, COUNT(*) as calls
        FROM tool_calls tc
        WHERE tc.session_id IN (SELECT s.id FROM sessions s WHERE 1=1 AND s.started_at >= '2020-01-01')
        GROUP BY tc.tool_server
      `)
      .all() as Array<{ detail: string }>;

    const details = plan.map((p) => p.detail).join(' | ');
    expect(details).toContain('SEARCH tc USING INDEX idx_tc_session');
    // The regressed `JOIN sessions` form scans the entire tool_calls table
    // (optionally via a different index, e.g. idx_tc_server) instead of
    // seeking it by session_id — assert the seek-by-session_id shape
    // specifically rather than a generic "no SCAN tc" check, since SQLite
    // can legitimately use `SCAN tc USING INDEX ...` for an unrelated
    // reason and a bare substring match would be too brittle either way.
    expect(details).not.toContain('SCAN tc USING INDEX idx_tc_server');
  });

  it('captures query + semantic mode in input_snippet for search tool calls', () => {
    const session = makeParsedSession();
    session.toolCalls.push({
      toolId: 'tc-5',
      sessionId: 'sess-1',
      timestamp: '2026-04-01T10:25:00Z',
      model: 'claude-sonnet-4-6',
      toolName: 'mcp__trace-mcp__search',
      toolServer: 'trace-mcp',
      toolShortName: 'search',
      inputParams: { query: 'authenticate user', semantic: 'on' },
      inputSizeChars: 40,
    });
    session.toolResults.set('tc-5', {
      toolId: 'tc-5',
      outputSizeChars: 300,
      isError: false,
      semanticDegraded: false,
    });
    store.storeSession(session);

    const calls = store.getToolCallsForOptimization({ period: 'all' });
    const searchCall = calls.find(
      (c) =>
        c.tool_name === 'mcp__trace-mcp__search' && c.input_snippet?.includes('authenticate user'),
    );
    expect(searchCall).toBeDefined();
    expect(searchCall!.input_snippet).toContain('authenticate user');
    expect(searchCall!.input_snippet).toContain('"semantic":"on"');
  });

  it('preMigrate preserves filenames with digits/hyphens and gates via user_version', () => {
    const rawDbPath = path.join(tmpDir, 'migration-test.db');
    const Database = (store as unknown as { db: { constructor: new (p: string) => any } }).db
      .constructor;
    const rawDb = new Database(rawDbPath);
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, project_path TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0, cache_create_tokens INTEGER DEFAULT 0,
        tool_call_count INTEGER DEFAULT 0, parsed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), timestamp TEXT NOT NULL,
        tool_name TEXT NOT NULL, tool_server TEXT NOT NULL, tool_short_name TEXT NOT NULL,
        input_size_chars INTEGER DEFAULT 0, output_size_chars INTEGER DEFAULT 0,
        output_tokens_estimate INTEGER DEFAULT 0, is_error INTEGER DEFAULT 0,
        target_file TEXT, model TEXT, input_snippet TEXT
      );
      INSERT INTO sessions (id, project_path, started_at, parsed_at) VALUES ('s1', '/proj', '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z');
      INSERT INTO tool_calls (id, session_id, timestamp, tool_name, tool_server, tool_short_name, target_file)
      VALUES
        ('1', 's1', 't', 'Read', 'builtin', 'Read', '404.html'),
        ('2', 's1', 't', 'Read', 'builtin', 'Read', '01-intro.md'),
        ('3', 's1', 't', 'Read', 'builtin', 'Read', '2fa.ts'),
        ('4', 's1', 't', 'Read', 'builtin', 'Read', '2024-report.csv'),
        ('5', 's1', 't', 'Read', 'builtin', 'Read', '-file.txt'),
        ('6', 's1', 't', 'Read', 'builtin', 'Read', '30'),
        ('7', 's1', 't', 'Read', 'builtin', 'Read', '&&'),
        ('8', 's1', 't', 'Read', 'builtin', 'Read', '-n'),
        ('9', 's1', 't', 'Read', 'builtin', 'Read', 'echo');
    `);
    expect(rawDb.pragma('user_version', { simple: true })).toBe(0);
    rawDb.close();

    const migratedStore = new AnalyticsStore(rawDbPath);
    const db = (migratedStore as unknown as { db: any }).db;
    expect(db.pragma('user_version', { simple: true })).toBe(1);

    const rows = db
      .prepare('SELECT id, target_file FROM tool_calls ORDER BY id ASC')
      .all() as Array<{ id: string; target_file: string | null }>;
    const fileById = Object.fromEntries(rows.map((r) => [r.id, r.target_file]));

    // Valid filenames preserved
    expect(fileById['1']).toBe('404.html');
    expect(fileById['2']).toBe('01-intro.md');
    expect(fileById['3']).toBe('2fa.ts');
    expect(fileById['4']).toBe('2024-report.csv');
    expect(fileById['5']).toBe('-file.txt');

    // Poisoned entries cleared
    expect(fileById['6']).toBeNull();
    expect(fileById['7']).toBeNull();
    expect(fileById['8']).toBeNull();
    expect(fileById['9']).toBeNull();

    // Now insert a row that would match if migration ran on every instantiation
    db.prepare(`
      INSERT INTO tool_calls (id, session_id, timestamp, tool_name, tool_server, tool_short_name, target_file)
      VALUES ('10', 's1', 't', 'Read', 'builtin', 'Read', '30')
    `).run();

    migratedStore.close();

    // Reopen store: user_version is 1, so preMigrate must NOT re-wipe tool_calls
    const reopenedStore = new AnalyticsStore(rawDbPath);
    const reopenedDb = (reopenedStore as unknown as { db: any }).db;
    const row10 = reopenedDb
      .prepare('SELECT target_file FROM tool_calls WHERE id = ?')
      .get('10') as {
      target_file: string | null;
    };
    expect(row10.target_file).toBe('30');
    reopenedStore.close();
  });
});

// TRA-641: the trace-mcp -> trace rename (TRA-611/614) means a migrated
// client logs tool_server: "trace" instead of "trace-mcp"/"trace_mcp".
// isTraceToolServer is the single shared predicate every analytics call
// site (rules.ts, real-savings.ts) must use so historical rows and
// post-migration rows both keep counting as "our own" tool calls.
describe('isTraceToolServer', () => {
  it('recognizes all known trace-mcp server key spellings', () => {
    expect(isTraceToolServer('trace')).toBe(true);
    expect(isTraceToolServer('trace-mcp')).toBe(true);
    expect(isTraceToolServer('trace_mcp')).toBe(true);
  });

  it('does not match unrelated or merely-similar server keys', () => {
    expect(isTraceToolServer('builtin')).toBe(false);
    expect(isTraceToolServer('phpstorm')).toBe(false);
    expect(isTraceToolServer('trace-mcp-http')).toBe(false);
    expect(isTraceToolServer('')).toBe(false);
  });
});
