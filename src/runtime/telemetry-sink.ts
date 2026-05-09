/**
 * Optional SQLite sink for tool-call telemetry.
 *
 * Off by default (`telemetry.enabled = true` in config to opt in). When enabled,
 * every recorded latency sample is appended to `~/.trace-mcp/telemetry.db` so
 * `analyze_perf` can compute per-tool stats over `1h | 24h | 7d | all` windows
 * across sessions. Pure append + indexed read; never mutates rows.
 *
 * Failure mode: any error opening or writing to the DB is logged once and the
 * sink is disabled — telemetry must never crash the server.
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import { TRACE_MCP_HOME, ensureGlobalDirs } from '../global.js';
import { logger } from '../logger.js';

export const TELEMETRY_DB_PATH = path.join(TRACE_MCP_HOME, 'telemetry.db');

export type AnalyzeWindow = '1h' | '24h' | '7d' | 'all';

interface ToolCallRow {
  ts: number;
  tool: string;
  duration_ms: number;
  is_error: number;
}

export interface PersistedToolStats {
  tool: string;
  count: number;
  errors: number;
  error_rate: number;
  p50: number;
  p95: number;
  max: number;
}

/**
 * Lazily-initialized telemetry sink. Holds the DB handle and prepared statements
 * once `recordCall` is invoked for the first time. All operations are best-effort:
 * on failure the sink turns into a no-op for the rest of the session.
 */
export class TelemetrySink {
  private db: Database.Database | null = null;
  private insertStmt: Database.Statement | null = null;
  private disabled = false;
  private dbPath: string;
  private maxRows: number;

  constructor(opts: { dbPath?: string; maxRows?: number } = {}) {
    this.dbPath = opts.dbPath ?? TELEMETRY_DB_PATH;
    this.maxRows = opts.maxRows ?? 500_000;
  }

  /** Persist a tool call. Silently no-ops after a previous failure. */
  recordCall(
    toolName: string,
    durationMs: number,
    isError: boolean,
    ts: number = Date.now(),
  ): void {
    if (this.disabled) return;
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    try {
      this.ensureOpen();
      this.insertStmt!.run(ts, toolName, durationMs, isError ? 1 : 0);
    } catch (e) {
      logger.warn({ error: e, dbPath: this.dbPath }, 'Telemetry sink write failed — disabling');
      this.disabled = true;
      this.close();
    }
  }

  /**
   * Compute aggregated per-tool latency for a time window. Reads only — safe to call
   * concurrently with writes (SQLite handles its own locking).
   */
  getStats(window: AnalyzeWindow, toolFilter?: string): PersistedToolStats[] {
    if (this.disabled) return [];
    try {
      this.ensureOpen();
    } catch {
      return [];
    }
    const since = windowToSinceMs(window);
    const rows = toolFilter
      ? (this.db!.prepare(
          'SELECT ts, tool, duration_ms, is_error FROM tool_calls WHERE ts >= ? AND tool = ? ORDER BY tool, duration_ms',
        ).all(since, toolFilter) as ToolCallRow[])
      : (this.db!.prepare(
          'SELECT ts, tool, duration_ms, is_error FROM tool_calls WHERE ts >= ? ORDER BY tool, duration_ms',
        ).all(since) as ToolCallRow[]);

    // Group by tool — rows already sorted by (tool, duration_ms) so percentile math is direct.
    const grouped = new Map<string, ToolCallRow[]>();
    for (const row of rows) {
      const arr = grouped.get(row.tool);
      if (arr) arr.push(row);
      else grouped.set(row.tool, [row]);
    }

    const out: PersistedToolStats[] = [];
    for (const [tool, group] of grouped) {
      const durations = group.map((r) => r.duration_ms);
      const errors = group.reduce((acc, r) => acc + (r.is_error ? 1 : 0), 0);
      out.push({
        tool,
        count: group.length,
        errors,
        error_rate: group.length > 0 ? errors / group.length : 0,
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        max: durations[durations.length - 1] ?? 0,
      });
    }
    out.sort((a, b) => b.p95 - a.p95);
    return out;
  }

  /** Close the DB handle. Safe to call repeatedly. */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
      this.insertStmt = null;
    }
  }

  private ensureOpen(): void {
    if (this.db) return;
    ensureGlobalDirs();
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.pragma(`journal_size_limit = ${100 * 1024 * 1024}`);
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        tool TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        is_error INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(ts);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_ts ON tool_calls(tool, ts);`,
    );
    this.insertStmt = this.db.prepare(
      'INSERT INTO tool_calls (ts, tool, duration_ms, is_error) VALUES (?, ?, ?, ?)',
    );
    this.maybePrune();
  }

  /** Prune oldest rows when total count exceeds maxRows. Cheap O(1) check + bulk delete. */
  private maybePrune(): void {
    if (this.maxRows === 0 || !this.db) return;
    const row = this.db.prepare('SELECT COUNT(*) as n FROM tool_calls').get() as { n: number };
    if (row.n <= this.maxRows) return;
    // Delete oldest rows beyond the cap. Keeps a margin to avoid pruning every insert.
    const excess = row.n - Math.floor(this.maxRows * 0.9);
    this.db
      .prepare(
        'DELETE FROM tool_calls WHERE id IN (SELECT id FROM tool_calls ORDER BY ts ASC LIMIT ?)',
      )
      .run(excess);
  }
}

function windowToSinceMs(window: AnalyzeWindow): number {
  const now = Date.now();
  switch (window) {
    case '1h':
      return now - 60 * 60 * 1000;
    case '24h':
      return now - 24 * 60 * 60 * 1000;
    case '7d':
      return now - 7 * 24 * 60 * 60 * 1000;
    case 'all':
      return 0;
  }
}

/** Linear-interp percentile; expects sorted ascending. Returns 0 for empty input. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  const frac = idx - lo;
  return (sorted[lo] ?? 0) * (1 - frac) + (sorted[hi] ?? 0) * frac;
}
