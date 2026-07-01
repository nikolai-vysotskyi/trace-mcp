/**
 * Session-tracking persistence — extracted from `DecisionStore` (Task:
 * god-class decomposition). Owns four session-related concerns, all keyed off
 * their own tables and depending only on `this.db`:
 *
 *   - `mined_sessions`          — byte-offset incremental mining cursor for
 *     file-based Claude/Claw session logs.
 *   - `mined_provider_sessions` — (timestamp, message_id) cursor for
 *     provider-backed sessions (Hermes / Codex) where a byte offset is
 *     ill-defined.
 *   - `llm_extraction_cache`    — cached raw LLM extraction JSON per
 *     (session_id, content_sha, model) triple, to avoid re-paying tokens.
 *   - `session_chunks` (+ FTS)  — cross-session conversation content search.
 *
 * `DecisionStore` holds one `SessionOperations` instance and delegates its
 * public session methods to it verbatim — the public API and behavior are
 * unchanged, only the implementation moved.
 */

import type Database from 'better-sqlite3';
import type { SessionChunkInput, SessionSearchResult } from './decision-types.js';

export class SessionOperations {
  constructor(private readonly db: Database.Database) {}

  // ── MINED SESSIONS ────────────────────────────────────────────────

  isSessionMined(sessionPath: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM mined_sessions WHERE session_path = ?')
      .get(sessionPath);
    return !!row;
  }

  /**
   * @deprecated Use {@link updateSessionCursor} for incremental cursor-aware
   * mining. Retained for back-compat with callers that haven't migrated.
   * Internally writes cursor_offset=0, last_size=0, last_modified_ms=now —
   * which means the next {@link getSessionCursor} call will treat the file
   * as "grown" and re-read it in full. That's intentional fallback behaviour.
   */
  markSessionMined(sessionPath: string, decisionsFound: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mined_sessions (
           session_path, mined_at, decisions_found,
           cursor_offset, last_size, last_modified_ms
         ) VALUES (?, ?, ?, 0, 0, ?)
         ON CONFLICT(session_path) DO UPDATE SET
           mined_at = excluded.mined_at,
           decisions_found = mined_sessions.decisions_found + excluded.decisions_found`,
      )
      .run(sessionPath, now, decisionsFound, Date.now());
  }

  getMinedSessionCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM mined_sessions').get() as { c: number }).c;
  }

  /**
   * Get the next-read cursor for a previously-mined session.
   *
   * Semantics:
   *  - Row missing → `{ cursor: 0, reason: 'unmined' }`
   *  - File shrank (current size < recorded last_size) → `{ cursor: 0, reason: 'restart_shrunk' }`
   *    Indicates rotation/truncation; caller should restart from offset 0.
   *  - File unchanged (same size + same mtime) → `null` (caller should skip)
   *  - File grew → `{ cursor: cursor_offset, reason: 'incremental' }`
   *
   * `currentModifiedMs` is optional. When supplied, an unchanged-size +
   * unchanged-mtime pair returns `null`; when omitted, the unchanged-size
   * branch still skips. Pass it whenever you have it (you already `statSync`).
   */
  getSessionCursor(
    sessionPath: string,
    currentSize: number,
    currentModifiedMs?: number,
  ): { cursor: number; reason: 'unmined' | 'restart_shrunk' | 'incremental' } | null {
    const row = this.db
      .prepare(
        'SELECT cursor_offset, last_size, last_modified_ms FROM mined_sessions WHERE session_path = ?',
      )
      .get(sessionPath) as
      | { cursor_offset: number; last_size: number; last_modified_ms: number }
      | undefined;

    if (!row) return { cursor: 0, reason: 'unmined' };

    // File shrank → almost certainly rotated or truncated. Start over.
    if (currentSize < row.last_size) {
      return { cursor: 0, reason: 'restart_shrunk' };
    }

    // Unchanged: size identical AND (no mtime supplied OR mtime matches).
    // Without mtime we still skip on size match — appended-then-truncated-
    // -then-rewritten-to-same-size is vanishingly rare in append-only logs.
    if (currentSize === row.last_size) {
      if (currentModifiedMs == null || currentModifiedMs === row.last_modified_ms) {
        return null;
      }
    }

    // File grew (or shrunk-then-regrew to <= last_size which the above
    // branches handled). Resume from the recorded byte offset.
    return { cursor: row.cursor_offset, reason: 'incremental' };
  }

  /**
   * Atomically update the cursor after a successful mining pass.
   * Idempotent: re-running with identical inputs is a no-op write.
   */
  updateSessionCursor(opts: {
    sessionPath: string;
    /** New byte offset (= total bytes consumed). */
    cursor: number;
    /** Current file size on disk after the read. */
    size: number;
    /** Current file mtime in ms after the read. */
    modifiedMs: number;
    /** Delta of decisions extracted this pass. */
    decisionsFound: number;
  }): void {
    const minedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mined_sessions (
           session_path, mined_at, decisions_found,
           cursor_offset, last_size, last_modified_ms
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_path) DO UPDATE SET
           mined_at = excluded.mined_at,
           decisions_found = mined_sessions.decisions_found + excluded.decisions_found,
           cursor_offset = excluded.cursor_offset,
           last_size = excluded.last_size,
           last_modified_ms = excluded.last_modified_ms`,
      )
      .run(opts.sessionPath, minedAt, opts.decisionsFound, opts.cursor, opts.size, opts.modifiedMs);
  }

  // ── MINED PROVIDER SESSIONS (Hermes / Codex incremental cursor) ───
  //
  // Mirrors the byte-offset cursor surface for file-based sessions, but the
  // primitive is a (timestamp, message_id) pair because provider sessions are
  // SQLite-backed (Hermes) or otherwise iterated record-by-record (Codex). A
  // byte offset would be ill-defined.

  /** Marker returned by {@link getProviderSessionCursor}. `null` means "no
   *  changes since last pass — skip without iterating messages". */
  getProviderSessionCursor(
    sessionKey: string,
    currentSeenSize?: number,
    currentSeenModifiedMs?: number,
  ): {
    lastTimestampMs: number;
    lastMessageId: string;
    reason: 'unmined' | 'restart_shrunk' | 'incremental';
  } | null {
    const row = this.db
      .prepare(
        'SELECT last_timestamp_ms, last_message_id, last_seen_size, last_seen_modified_ms FROM mined_provider_sessions WHERE session_key = ?',
      )
      .get(sessionKey) as
      | {
          last_timestamp_ms: number;
          last_message_id: string;
          last_seen_size: number;
          last_seen_modified_ms: number;
        }
      | undefined;

    if (!row) {
      return { lastTimestampMs: 0, lastMessageId: '', reason: 'unmined' };
    }

    // SessionHandle.sizeBytes / lastModifiedMs are optional on the provider
    // contract. When BOTH are supplied we can detect rotation (SQLite DB
    // shrank → restart) and skip unchanged sessions without iterating.
    if (currentSeenSize !== undefined && row.last_seen_size > 0) {
      if (currentSeenSize < row.last_seen_size) {
        return { lastTimestampMs: 0, lastMessageId: '', reason: 'restart_shrunk' };
      }
      if (
        currentSeenSize === row.last_seen_size &&
        (currentSeenModifiedMs === undefined || currentSeenModifiedMs === row.last_seen_modified_ms)
      ) {
        return null;
      }
    } else if (
      // No size signal — fall back to mtime-only skip when both sides supply it
      // and the value matches. Without either signal we always iterate.
      currentSeenModifiedMs !== undefined &&
      row.last_seen_modified_ms > 0 &&
      currentSeenModifiedMs === row.last_seen_modified_ms
    ) {
      return null;
    }

    return {
      lastTimestampMs: row.last_timestamp_ms,
      lastMessageId: row.last_message_id,
      reason: 'incremental',
    };
  }

  /** Atomically update the provider-session cursor after a successful pass.
   *  Idempotent: identical inputs are a no-op write. */
  updateProviderSessionCursor(opts: {
    sessionKey: string;
    /** Highest message timestamp consumed this pass (ms since epoch). */
    lastTimestampMs: number;
    /** Stable per-message id (string) — used as a tie-breaker when two
     *  messages share a timestamp. Empty string is allowed. */
    lastMessageId: string;
    /** Current SessionHandle.sizeBytes seen this pass — for rotation detection.
     *  Pass 0 when the provider does not report a size. */
    seenSize: number;
    /** Current SessionHandle.lastModifiedMs seen this pass. */
    seenModifiedMs: number;
    /** Delta of decisions extracted this pass. */
    decisionsFound: number;
  }): void {
    const minedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO mined_provider_sessions (
           session_key, mined_at, decisions_found,
           last_timestamp_ms, last_message_id,
           last_seen_size, last_seen_modified_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           mined_at = excluded.mined_at,
           decisions_found = mined_provider_sessions.decisions_found + excluded.decisions_found,
           last_timestamp_ms = excluded.last_timestamp_ms,
           last_message_id = excluded.last_message_id,
           last_seen_size = excluded.last_seen_size,
           last_seen_modified_ms = excluded.last_seen_modified_ms`,
      )
      .run(
        opts.sessionKey,
        minedAt,
        opts.decisionsFound,
        opts.lastTimestampMs,
        opts.lastMessageId,
        opts.seenSize,
        opts.seenModifiedMs,
      );
  }

  // ── LLM EXTRACTION CACHE ──────────────────────────────────────────
  //
  // Cache the raw JSON the LLM produced for a (session_id, content_sha,
  // model) triple. Re-mining the same session under the same model returns
  // the cached extraction instead of re-paying tokens. Schema swap on the
  // mining strategy or a model rename naturally produces cache misses.

  getCachedLlmExtraction(sessionId: string, contentSha: string, model: string): string | null {
    const row = this.db
      .prepare(
        'SELECT extracted_json FROM llm_extraction_cache WHERE session_id = ? AND content_sha = ? AND model = ?',
      )
      .get(sessionId, contentSha, model) as { extracted_json: string } | undefined;
    return row?.extracted_json ?? null;
  }

  putCachedLlmExtraction(
    sessionId: string,
    contentSha: string,
    model: string,
    extractedJson: string,
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO llm_extraction_cache (session_id, content_sha, model, extracted_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(sessionId, contentSha, model, extractedJson, new Date().toISOString());
  }

  // ── SESSION CHUNKS (cross-session content search) ─────────────────

  addSessionChunks(chunks: SessionChunkInput[]): number {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO session_chunks (session_id, project_root, chunk_index, role, content, timestamp, referenced_files)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((items: SessionChunkInput[]) => {
      let count = 0;
      for (const c of items) {
        const info = insert.run(
          c.session_id,
          c.project_root,
          c.chunk_index,
          c.role,
          c.content,
          c.timestamp,
          c.referenced_files?.join(',') ?? null,
        );
        if (info.changes > 0) count++;
      }
      return count;
    });
    return insertMany(chunks);
  }

  isSessionIndexed(sessionId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM session_chunks WHERE session_id = ? LIMIT 1')
      .get(sessionId);
    return !!row;
  }

  searchSessions(
    query: string,
    opts: {
      project_root?: string;
      limit?: number;
    } = {},
  ): SessionSearchResult[] {
    const limit = opts.limit ?? 20;
    if (opts.project_root) {
      return this.db
        .prepare(`
        SELECT sc.id as chunk_id, sc.session_id, sc.role, sc.content, sc.timestamp,
               sc.referenced_files, rank
        FROM session_chunks_fts fts
        JOIN session_chunks sc ON sc.id = fts.rowid
        WHERE session_chunks_fts MATCH ?
          AND sc.project_root = ?
        ORDER BY rank
        LIMIT ?
      `)
        .all(query, opts.project_root, limit) as SessionSearchResult[];
    }
    return this.db
      .prepare(`
      SELECT sc.id as chunk_id, sc.session_id, sc.role, sc.content, sc.timestamp,
             sc.referenced_files, rank
      FROM session_chunks_fts fts
      JOIN session_chunks sc ON sc.id = fts.rowid
      WHERE session_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `)
      .all(query, limit) as SessionSearchResult[];
  }

  getSessionChunkCount(projectRoot?: string): number {
    if (projectRoot) {
      return (
        this.db
          .prepare('SELECT COUNT(*) as c FROM session_chunks WHERE project_root = ?')
          .get(projectRoot) as { c: number }
      ).c;
    }
    return (this.db.prepare('SELECT COUNT(*) as c FROM session_chunks').get() as { c: number }).c;
  }

  getIndexedSessionIds(projectRoot?: string): string[] {
    const filter = projectRoot ? ' WHERE project_root = ?' : '';
    const params = projectRoot ? [projectRoot] : [];
    const rows = this.db
      .prepare(`SELECT DISTINCT session_id FROM session_chunks${filter}`)
      .all(...params) as Array<{ session_id: string }>;
    return rows.map((r) => r.session_id);
  }
}
