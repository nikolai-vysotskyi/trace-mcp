/**
 * Activity store — the durable half of the session journal.
 *
 * `SessionJournal` keeps its entries in memory because that is what the
 * dedup/coaching logic needs: one session, one array, gone when the session
 * ends. The Activity tab asks a different question — "what has been happening
 * in this project" — and answering it from those arrays means the answer is
 * always zero: a client disconnect drops the journal, and every agent run is a
 * client that disconnects. Measured on a live daemon (TRA-1071): one tool call
 * is visible while the session is open, and `total_calls` is back to 0 one
 * second after the client sends DELETE /mcp.
 *
 * So Activity is project history, and history lives on disk. Every journal
 * entry the daemon broadcasts is also appended here, keyed by project root, and
 * read back per time window.
 *
 * Its own DB file rather than a table in `analytics.db`: that one is written by
 * the log-sync path (a Stop hook fires one per turn) and is 100 MB+ on this
 * machine. Two writers with different cadences on one WAL buys nothing here.
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureGlobalDirs, TRACE_MCP_HOME } from '../global.js';
import { logger } from '../logger.js';
import { restrictDbPerms } from '../shared/db-perms.js';

export const ACTIVITY_DB_PATH = path.join(TRACE_MCP_HOME, 'activity.db');

/** How far back the store keeps entries. Covers the widest UI window (24h) with room to spare. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Flush when this many entries are buffered, whatever the timer says. */
const FLUSH_AT = 128;
/** …or this long after the first buffered entry, whichever comes first. */
const FLUSH_INTERVAL_MS = 2_000;
/** Pruning old rows is bookkeeping, not user-visible work — hourly is plenty. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface ActivityEntry {
  ts: number;
  project: string;
  session_id: string;
  tool: string;
  params_summary: string;
  result_count: number;
  result_tokens?: number;
  latency_ms?: number;
  is_error: boolean;
}

interface ActivityRow {
  ts: number;
  session_id: string;
  tool: string;
  params_summary: string;
  result_count: number;
  result_tokens: number | null;
  latency_ms: number | null;
  is_error: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS journal_entries (
  ts INTEGER NOT NULL,
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  params_summary TEXT NOT NULL DEFAULT '',
  result_count INTEGER NOT NULL DEFAULT 0,
  result_tokens INTEGER,
  latency_ms INTEGER,
  is_error INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_je_project_ts ON journal_entries(project, ts);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class ActivityStore {
  private db: Database.Database;
  private buffer: ActivityEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private lastPruneAt = 0;
  /** One log line per failure kind — a full disk would otherwise write a line per batch. */
  private warned = { flush: false, prune: false };
  private readonly insertStmt: Database.Statement;
  private readonly recordingSinceMs: number;

  constructor(dbPath: string = ACTIVITY_DB_PATH) {
    ensureGlobalDirs();
    this.db = new Database(dbPath);
    restrictDbPerms(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    // Entry loss on a hard crash costs a few seconds of a stats chart. Paying a
    // per-batch fsync on the daemon's main thread for that is a bad trade.
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA_SQL);

    const now = Date.now();
    const existing = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('recording_since') as { value: string } | undefined;
    if (existing) {
      this.recordingSinceMs = Number(existing.value) || now;
    } else {
      this.db
        .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('recording_since', String(now));
      this.recordingSinceMs = now;
    }

    this.insertStmt = this.db.prepare(
      `INSERT INTO journal_entries
         (ts, project, session_id, tool, params_summary, result_count, result_tokens, latency_ms, is_error)
       VALUES (@ts, @project, @session_id, @tool, @params_summary, @result_count, @result_tokens, @latency_ms, @is_error)`,
    );
  }

  /**
   * Buffer one entry. Writes are batched: better-sqlite3 is synchronous, and
   * this runs on the same thread that answers /health.
   */
  record(entry: ActivityEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length >= FLUSH_AT) {
      this.flush();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    }
  }

  /** Write buffered entries out. Safe to call at any time; a no-op when empty. */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      this.db.transaction((rows: ActivityEntry[]) => {
        for (const e of rows) {
          this.insertStmt.run({
            ts: e.ts,
            project: e.project,
            session_id: e.session_id,
            tool: e.tool,
            params_summary: e.params_summary ?? '',
            result_count: e.result_count ?? 0,
            result_tokens: e.result_tokens ?? null,
            latency_ms: e.latency_ms ?? null,
            is_error: e.is_error ? 1 : 0,
          });
        }
      })(batch);
    } catch (e) {
      // A failed batch is a hole in a chart, not a reason to take the daemon
      // down. Dropped deliberately — retrying would grow the buffer unbounded.
      // Silently, though, this reproduces the very bug this store exists to
      // fix: a disk that fills up after the daemon opened the DB sends Activity
      // back to zero with nothing in the log to say why. Say it once.
      if (!this.warned.flush) {
        this.warned.flush = true;
        logger.warn({ err: e }, 'activity store write failed — Activity history will have gaps');
      }
    }
    this.prune();
  }

  /**
   * Entries for one project inside [since, until], oldest-first.
   * Flushes first so a call made a second ago is not missing from its own tab.
   */
  listForProject(project: string, since: number, until: number): ActivityRow[] {
    this.flush();
    return this.db
      .prepare(
        `SELECT ts, session_id, tool, params_summary, result_count, result_tokens, latency_ms, is_error
           FROM journal_entries
          WHERE project = ? AND ts >= ? AND ts <= ?
          ORDER BY ts ASC`,
      )
      .all(project, since, until) as ActivityRow[];
  }

  /**
   * Earliest moment this store can have data for: when it started recording, or
   * the retention cutoff, whichever is later. The UI needs this to stop offering
   * a 24h window over 12 minutes of data.
   *
   * ponytail: this is "recording started at", not "covered without gaps" — a
   * daemon that was off for two hours leaves a hole this number does not
   * describe. Track uptime intervals here if the gap ever matters.
   */
  recordingSince(): number {
    return Math.max(this.recordingSinceMs, Date.now() - RETENTION_MS);
  }

  /** Drop rows past the retention horizon. Throttled — see PRUNE_INTERVAL_MS. */
  private prune(): void {
    const now = Date.now();
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return;
    this.lastPruneAt = now;
    try {
      this.db.prepare('DELETE FROM journal_entries WHERE ts < ?').run(now - RETENTION_MS);
    } catch (e) {
      // Retention is best-effort; a locked DB just means we prune next hour.
      if (!this.warned.prune) {
        this.warned.prune = true;
        logger.warn({ err: e }, 'activity store prune failed — retrying next hour');
      }
    }
  }

  close(): void {
    this.flush();
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
