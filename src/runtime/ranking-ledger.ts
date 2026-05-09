/**
 * Persistent ranking ledger.
 *
 * Append-only SQLite log of retrieval events: when a search-like tool returns a
 * ranked list, we record the top-N symbol_ids alongside the query. When a later
 * tool call (`get_symbol`, `register_edit`, etc.) acts on one of those symbols
 * within an attribution window, we mark the originating event as "accepted".
 *
 * The ledger feeds {@link tuneWeights} (Phase 4b) — by comparing acceptance
 * rates across channels (lexical / structural / similarity / identity), we can
 * learn per-repo overrides for the signal-fusion weights.
 *
 * Design constraints:
 *   - Off by default (only enabled when telemetry.enabled = true; sharing the
 *     same opt-in toggle keeps the user in control of disk writes).
 *   - All operations best-effort — a write failure disables the ledger but
 *     never crashes the server.
 *   - Schema versioned; migrations are append-only column adds.
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import { ensureGlobalDirs, TRACE_MCP_HOME } from '../global.js';
import { logger } from '../logger.js';

export const RANKING_DB_PATH = path.join(TRACE_MCP_HOME, 'ranking.db');

/** Window during which a follow-up action is attributed to a recent retrieval. */
export const DEFAULT_ATTRIBUTION_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

export type Channel = 'lexical' | 'structural' | 'similarity' | 'identity';

export interface RankingEvent {
  /** Free-form tool name (e.g. "search", "get_feature_context"). */
  tool: string;
  /** Optional originating query string. */
  query: string | null;
  /** Top-N symbol_ids in rank order. */
  topSymbolIds: string[];
  /** Project identifier — file system path of the workspace root. */
  repo: string;
  /** Per-channel rank contributions if available. Lets tune_weights attribute success. */
  channelHints?: Partial<Record<Channel, string[]>>;
  /** Optional timestamp override (ms). */
  ts?: number;
}

export interface ChannelStats {
  channel: Channel;
  shown: number;
  accepted: number;
  acceptance_rate: number;
}

export interface LedgerStats {
  total_events: number;
  total_accepted: number;
  acceptance_rate: number;
  by_channel: ChannelStats[];
}

interface EventRow {
  id: number;
  ts: number;
  tool: string;
  query: string | null;
  repo: string;
  top_symbols: string;
  channel_hints: string | null;
  accepted: number;
  accepted_symbol_id: string | null;
}

/**
 * Persistent ranking-event store. Lazy DB open; never throws to callers.
 */
export class RankingLedger {
  private db: Database.Database | null = null;
  private disabled = false;
  private dbPath: string;
  private insertEventStmt: Database.Statement | null = null;
  private markAcceptedStmt: Database.Statement | null = null;
  private findCandidateStmt: Database.Statement | null = null;
  private attributionWindowMs: number;

  constructor(opts: { dbPath?: string; attributionWindowMs?: number } = {}) {
    this.dbPath = opts.dbPath ?? RANKING_DB_PATH;
    this.attributionWindowMs = opts.attributionWindowMs ?? DEFAULT_ATTRIBUTION_WINDOW_MS;
  }

  /** Record a ranked retrieval. Best-effort. */
  recordEvent(event: RankingEvent): void {
    if (this.disabled) return;
    try {
      this.ensureOpen();
      const ts = event.ts ?? Date.now();
      this.insertEventStmt!.run(
        ts,
        event.tool,
        event.query,
        event.repo,
        JSON.stringify(event.topSymbolIds),
        event.channelHints ? JSON.stringify(event.channelHints) : null,
      );
    } catch (e) {
      logger.warn({ error: e, dbPath: this.dbPath }, 'Ranking ledger write failed — disabling');
      this.disabled = true;
      this.close();
    }
  }

  /**
   * Attempt to attribute a downstream action (a `get_symbol` call etc.) to the
   * most recent unaccepted event whose top list contains `symbolId`. Returns
   * true when a row was marked accepted.
   */
  recordAcceptance(repo: string, symbolId: string, ts: number = Date.now()): boolean {
    if (this.disabled) return false;
    try {
      this.ensureOpen();
      const since = ts - this.attributionWindowMs;
      const candidates = this.findCandidateStmt!.all(repo, since) as EventRow[];
      // Find the freshest event whose top list contains the symbol.
      for (const row of candidates) {
        const top = parseSymbolList(row.top_symbols);
        if (top.includes(symbolId)) {
          this.markAcceptedStmt!.run(symbolId, row.id);
          return true;
        }
      }
      return false;
    } catch (e) {
      logger.warn({ error: e, dbPath: this.dbPath }, 'Ranking ledger acceptance write failed');
      return false;
    }
  }

  /** Aggregate per-channel acceptance for a repo (or all repos if omitted). */
  getStats(repo?: string): LedgerStats | null {
    if (this.disabled) return null;
    try {
      this.ensureOpen();
    } catch {
      return null;
    }
    const rows = repo
      ? (this.db!.prepare('SELECT * FROM ranking_events WHERE repo = ?').all(repo) as EventRow[])
      : (this.db!.prepare('SELECT * FROM ranking_events').all() as EventRow[]);

    const channelTotals: Record<Channel, ChannelStats> = {
      lexical: { channel: 'lexical', shown: 0, accepted: 0, acceptance_rate: 0 },
      structural: { channel: 'structural', shown: 0, accepted: 0, acceptance_rate: 0 },
      similarity: { channel: 'similarity', shown: 0, accepted: 0, acceptance_rate: 0 },
      identity: { channel: 'identity', shown: 0, accepted: 0, acceptance_rate: 0 },
    };
    let totalAccepted = 0;

    for (const row of rows) {
      if (row.accepted === 1) totalAccepted += 1;
      const hints = row.channel_hints ? safeParseHints(row.channel_hints) : null;
      if (!hints || !row.accepted_symbol_id) continue;
      for (const channel of Object.keys(hints) as Channel[]) {
        const ids = hints[channel] ?? [];
        channelTotals[channel].shown += 1;
        if (ids.includes(row.accepted_symbol_id)) {
          channelTotals[channel].accepted += 1;
        }
      }
    }
    for (const c of Object.values(channelTotals)) {
      c.acceptance_rate = c.shown > 0 ? c.accepted / c.shown : 0;
    }

    return {
      total_events: rows.length,
      total_accepted: totalAccepted,
      acceptance_rate: rows.length > 0 ? totalAccepted / rows.length : 0,
      by_channel: Object.values(channelTotals),
    };
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
      this.insertEventStmt = null;
      this.markAcceptedStmt = null;
      this.findCandidateStmt = null;
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
      `CREATE TABLE IF NOT EXISTS ranking_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        tool TEXT NOT NULL,
        query TEXT,
        repo TEXT NOT NULL,
        top_symbols TEXT NOT NULL,
        channel_hints TEXT,
        accepted INTEGER NOT NULL DEFAULT 0,
        accepted_symbol_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ranking_events_repo_ts ON ranking_events(repo, ts);
      CREATE INDEX IF NOT EXISTS idx_ranking_events_unaccepted ON ranking_events(repo, ts)
        WHERE accepted = 0;`,
    );
    this.insertEventStmt = this.db.prepare(
      'INSERT INTO ranking_events (ts, tool, query, repo, top_symbols, channel_hints) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.markAcceptedStmt = this.db.prepare(
      'UPDATE ranking_events SET accepted = 1, accepted_symbol_id = ? WHERE id = ?',
    );
    this.findCandidateStmt = this.db.prepare(
      'SELECT * FROM ranking_events WHERE repo = ? AND ts >= ? AND accepted = 0 ORDER BY ts DESC LIMIT 50',
    );
  }
}

function parseSymbolList(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function safeParseHints(json: string): Partial<Record<Channel, string[]>> | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as Partial<Record<Channel, string[]>>;
  } catch {
    return null;
  }
}
