import Database from 'better-sqlite3';
import path from 'node:path';
import { TRACE_MCP_HOME, ensureGlobalDirs } from '../global.js';
import type { ParsedSession } from './log-parser.js';

const ANALYTICS_DB_PATH = path.join(TRACE_MCP_HOME, 'analytics.db');

export interface ToolCallRow {
  tool_name: string;
  tool_server: string;
  tool_short_name: string;
  output_size_chars: number;
  output_tokens_estimate: number;
  target_file: string | null;
  is_error: number;
  session_id: string;
  input_snippet: string | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_create_tokens INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  parsed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  timestamp TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_server TEXT NOT NULL,
  tool_short_name TEXT NOT NULL,
  input_size_chars INTEGER DEFAULT 0,
  output_size_chars INTEGER DEFAULT 0,
  output_tokens_estimate INTEGER DEFAULT 0,
  is_error INTEGER DEFAULT 0,
  target_file TEXT,
  model TEXT,
  input_snippet TEXT
);

CREATE INDEX IF NOT EXISTS idx_tc_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tc_server ON tool_calls(tool_server);
CREATE INDEX IF NOT EXISTS idx_tc_name ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tc_file ON tool_calls(target_file);

CREATE TABLE IF NOT EXISTS sync_state (
  file_path TEXT PRIMARY KEY,
  mtime_ms REAL NOT NULL,
  parsed_at TEXT NOT NULL
);
`;

export class AnalyticsStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    ensureGlobalDirs();
    const p = dbPath ?? ANALYTICS_DB_PATH;
    this.db = new Database(p);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = OFF'); // for performance during bulk inserts
    this.db.exec(SCHEMA_SQL);
  }

  /** Check if a session file needs re-parsing (by mtime) */
  needsSync(filePath: string, mtime: number): boolean {
    const row = this.db
      .prepare('SELECT mtime_ms FROM sync_state WHERE file_path = ?')
      .get(filePath) as { mtime_ms: number } | undefined;
    if (!row) return true;
    return mtime > row.mtime_ms;
  }

  /** Store a parsed session (upsert) */
  storeSession(parsed: ParsedSession): void {
    const tx = this.db.transaction(() => {
      const now = new Date().toISOString();
      const s = parsed.summary;

      // Upsert session
      this.db
        .prepare(`
        INSERT OR REPLACE INTO sessions (id, project_path, started_at, ended_at, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, tool_call_count, parsed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .run(
          s.sessionId,
          s.projectPath,
          s.startedAt,
          s.endedAt,
          s.model,
          s.usage.inputTokens,
          s.usage.outputTokens,
          s.usage.cacheReadTokens,
          s.usage.cacheCreateTokens,
          s.toolCallCount,
          now,
        );

      // Delete old tool calls for this session
      this.db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(s.sessionId);

      // Insert tool calls
      const insertTC = this.db.prepare(`
        INSERT INTO tool_calls (id, session_id, timestamp, tool_name, tool_server, tool_short_name, input_size_chars, output_size_chars, output_tokens_estimate, is_error, target_file, model, input_snippet)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const tc of parsed.toolCalls) {
        const result = parsed.toolResults.get(tc.toolId);
        const outputChars = result?.outputSizeChars ?? 0;
        const outputTokensEst = Math.ceil(outputChars / 3.5); // rough estimate
        // Store first 500 chars of Bash commands for optimization rule detection
        const snippet =
          tc.toolShortName === 'Bash' || tc.toolShortName === 'bash'
            ? typeof tc.inputParams['command'] === 'string'
              ? (tc.inputParams['command'] as string).slice(0, 500)
              : null
            : null;
        insertTC.run(
          tc.toolId,
          tc.sessionId,
          tc.timestamp,
          tc.toolName,
          tc.toolServer,
          tc.toolShortName,
          tc.inputSizeChars,
          outputChars,
          outputTokensEst,
          result?.isError ? 1 : 0,
          tc.targetFile ?? null,
          tc.model,
          snippet,
        );
      }
    });
    tx();
  }

  /** Mark a file as synced */
  markSynced(filePath: string, mtime: number): void {
    this.db
      .prepare(`
      INSERT OR REPLACE INTO sync_state (file_path, mtime_ms, parsed_at)
      VALUES (?, ?, ?)
    `)
      .run(filePath, mtime, new Date().toISOString());
  }

  // --- Query methods ---

  /** Get session analytics for a period */
  getSessionAnalytics(opts: {
    projectPath?: string;
    period?: 'today' | 'week' | 'month' | 'all';
    sessionId?: string;
  }): {
    sessions_count: number;
    totals: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_create_tokens: number;
      tool_calls: number;
      estimated_cost_usd: number;
    };
    by_tool_server: Record<string, { calls: number; output_tokens_est: number; pct: number }>;
    top_tools: { name: string; calls: number; output_tokens_est: number }[];
    top_files: { path: string; reads: number; tokens_est: number }[];
    models_used: Record<string, { sessions: number; tokens: number }>;
  } {
    let dateFilter = '';
    if (opts.sessionId) {
      dateFilter = `AND s.id = '${opts.sessionId}'`;
    } else if (opts.period && opts.period !== 'all') {
      const now = new Date();
      let since: Date;
      if (opts.period === 'today') {
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      } else if (opts.period === 'week') {
        since = new Date(now.getTime() - 7 * 86400000);
      } else {
        since = new Date(now.getTime() - 30 * 86400000);
      }
      dateFilter = `AND s.started_at >= '${since.toISOString()}'`;
    }

    const projectFilter = opts.projectPath ? `AND s.project_path = '${opts.projectPath}'` : '';
    const where = `WHERE 1=1 ${dateFilter} ${projectFilter}`;

    // Sessions summary
    const summary = this.db
      .prepare(`
      SELECT COUNT(*) as cnt,
        COALESCE(SUM(input_tokens),0) as input_tokens,
        COALESCE(SUM(output_tokens),0) as output_tokens,
        COALESCE(SUM(cache_read_tokens),0) as cache_read_tokens,
        COALESCE(SUM(cache_create_tokens),0) as cache_create_tokens,
        COALESCE(SUM(tool_call_count),0) as tool_calls
      FROM sessions s ${where}
    `)
      .get() as any;

    const inputCost =
      (summary.input_tokens * 3 +
        summary.cache_read_tokens * 0.3 +
        summary.cache_create_tokens * 3.75) /
      1_000_000;
    const outputCost = (summary.output_tokens * 15) / 1_000_000;
    const estimatedCost = Math.round((inputCost + outputCost) * 100) / 100;

    // By tool server
    const serverRows = this.db
      .prepare(`
      SELECT tc.tool_server, COUNT(*) as calls, COALESCE(SUM(tc.output_tokens_estimate),0) as output_tokens_est
      FROM tool_calls tc JOIN sessions s ON tc.session_id = s.id ${where}
      GROUP BY tc.tool_server ORDER BY calls DESC
    `)
      .all() as any[];

    const totalCalls = serverRows.reduce((s: number, r: any) => s + r.calls, 0);
    const byServer: Record<string, { calls: number; output_tokens_est: number; pct: number }> = {};
    for (const r of serverRows) {
      byServer[r.tool_server] = {
        calls: r.calls,
        output_tokens_est: r.output_tokens_est,
        pct: totalCalls > 0 ? Math.round((r.calls / totalCalls) * 100) : 0,
      };
    }

    // Top tools
    const topTools = this.db
      .prepare(`
      SELECT tc.tool_name as name, COUNT(*) as calls, COALESCE(SUM(tc.output_tokens_estimate),0) as output_tokens_est
      FROM tool_calls tc JOIN sessions s ON tc.session_id = s.id ${where}
      GROUP BY tc.tool_name ORDER BY output_tokens_est DESC LIMIT 15
    `)
      .all() as any[];

    // Top files
    const topFiles = this.db
      .prepare(`
      SELECT tc.target_file as path, COUNT(*) as reads, COALESCE(SUM(tc.output_tokens_estimate),0) as tokens_est
      FROM tool_calls tc JOIN sessions s ON tc.session_id = s.id ${where}
      AND tc.target_file IS NOT NULL
      GROUP BY tc.target_file ORDER BY tokens_est DESC LIMIT 15
    `)
      .all() as any[];

    // Models used
    const modelRows = this.db
      .prepare(`
      SELECT model, COUNT(DISTINCT id) as sessions, COALESCE(SUM(input_tokens + output_tokens),0) as tokens
      FROM sessions s ${where} AND model IS NOT NULL AND model != ''
      GROUP BY model
    `)
      .all() as any[];

    const modelsUsed: Record<string, { sessions: number; tokens: number }> = {};
    for (const r of modelRows) {
      modelsUsed[r.model] = { sessions: r.sessions, tokens: r.tokens };
    }

    return {
      sessions_count: summary.cnt,
      totals: {
        input_tokens: summary.input_tokens,
        output_tokens: summary.output_tokens,
        cache_read_tokens: summary.cache_read_tokens,
        cache_create_tokens: summary.cache_create_tokens,
        tool_calls: summary.tool_calls,
        estimated_cost_usd: estimatedCost,
      },
      by_tool_server: byServer,
      top_tools: topTools,
      top_files: topFiles,
      models_used: modelsUsed,
    };
  }

  /** Get all tool calls for optimization analysis */
  getToolCallsForOptimization(opts: {
    projectPath?: string;
    period?: 'today' | 'week' | 'month' | 'all';
    sessionId?: string;
  }): ToolCallRow[] {
    let dateFilter = '';
    if (opts.sessionId) {
      dateFilter = `AND s.id = '${opts.sessionId}'`;
    } else if (opts.period && opts.period !== 'all') {
      const now = new Date();
      let since: Date;
      if (opts.period === 'today')
        since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (opts.period === 'week') since = new Date(now.getTime() - 7 * 86400000);
      else since = new Date(now.getTime() - 30 * 86400000);
      dateFilter = `AND s.started_at >= '${since.toISOString()}'`;
    }
    const projectFilter = opts.projectPath ? `AND s.project_path = '${opts.projectPath}'` : '';

    return this.db
      .prepare(`
      SELECT tc.tool_name, tc.tool_server, tc.tool_short_name, tc.target_file,
        tc.output_size_chars, tc.output_tokens_estimate, tc.session_id, tc.is_error,
        tc.input_snippet
      FROM tool_calls tc JOIN sessions s ON tc.session_id = s.id
      WHERE 1=1 ${dateFilter} ${projectFilter}
      ORDER BY tc.timestamp
    `)
      .all() as ToolCallRow[];
  }

  /** Get usage trends (daily aggregation) */
  getUsageTrends(
    days: number = 30,
  ): { date: string; sessions: number; tokens: number; cost_usd: number; tool_calls: number }[] {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    return this.db
      .prepare(`
      SELECT DATE(started_at) as date,
        COUNT(*) as sessions,
        SUM(input_tokens + output_tokens) as tokens,
        ROUND((SUM(input_tokens) * 3.0 + SUM(cache_read_tokens) * 0.3 + SUM(cache_create_tokens) * 3.75 + SUM(output_tokens) * 15.0) / 1000000.0, 2) as cost_usd,
        SUM(tool_call_count) as tool_calls
      FROM sessions WHERE started_at >= ?
      GROUP BY DATE(started_at) ORDER BY date
    `)
      .all(since) as any[];
  }

  /** Get synced session count */
  getSyncStats(): { sessions: number; tool_calls: number; files_synced: number } {
    const sessions = (this.db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as any).cnt;
    const toolCalls = (this.db.prepare('SELECT COUNT(*) as cnt FROM tool_calls').get() as any).cnt;
    const filesSynced = (this.db.prepare('SELECT COUNT(*) as cnt FROM sync_state').get() as any)
      .cnt;
    return { sessions, tool_calls: toolCalls, files_synced: filesSynced };
  }

  close(): void {
    this.db.close();
  }
}
