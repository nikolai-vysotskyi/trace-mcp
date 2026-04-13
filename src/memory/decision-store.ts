/**
 * Decision Store — persistent knowledge graph for architectural decisions,
 * tech choices, bug root causes, and preferences.
 *
 * Stored in ~/.trace-mcp/decisions.db (separate from per-repo code DBs).
 * Each decision has temporal validity (valid_from / valid_until) and optional
 * linkage to code symbols/files, enabling code-aware memory queries.
 */

import Database from 'better-sqlite3';
import { logger } from '../logger.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export type DecisionType =
  | 'architecture_decision'
  | 'tech_choice'
  | 'bug_root_cause'
  | 'preference'
  | 'tradeoff'
  | 'discovery'
  | 'convention';

export interface DecisionRow {
  id: number;
  /** Short title / summary */
  title: string;
  /** Full content — the actual decision text, reasoning, context */
  content: string;
  type: DecisionType;
  /** Project root this decision belongs to */
  project_root: string;
  /** Optional: service/federation name within the project (e.g., 'auth-api', 'user-service') */
  service_name: string | null;
  /** Optional: symbol FQN this decision is about */
  symbol_id: string | null;
  /** Optional: file path this decision is about */
  file_path: string | null;
  /** Optional: tags for categorization (JSON array) */
  tags: string | null;
  /** ISO timestamp when the decision became valid */
  valid_from: string;
  /** ISO timestamp when the decision was invalidated (null = still active) */
  valid_until: string | null;
  /** Session ID that produced this decision (for provenance) */
  session_id: string | null;
  /** Source: 'manual' (user added), 'mined' (extracted from logs), 'auto' (hook-extracted) */
  source: 'manual' | 'mined' | 'auto';
  /** Confidence score 0..1 for mined decisions */
  confidence: number;
  created_at: string;
}

export interface DecisionInput {
  title: string;
  content: string;
  type: DecisionType;
  project_root: string;
  /** Service/federation name within the project (e.g., 'auth-api') */
  service_name?: string;
  symbol_id?: string;
  file_path?: string;
  tags?: string[];
  valid_from?: string;
  session_id?: string;
  source?: 'manual' | 'mined' | 'auto';
  confidence?: number;
}

export interface DecisionQuery {
  project_root?: string;
  /** Filter by service/federation name within the project */
  service_name?: string;
  type?: DecisionType;
  symbol_id?: string;
  file_path?: string;
  tag?: string;
  /** Only return decisions active at this timestamp (default: now) */
  as_of?: string;
  /** Include invalidated decisions (default: false) */
  include_invalidated?: boolean;
  /** Full-text search query */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface DecisionTimelineEntry {
  id: number;
  title: string;
  type: DecisionType;
  valid_from: string;
  valid_until: string | null;
  is_active: boolean;
}

export interface SessionChunkRow {
  id: number;
  session_id: string;
  project_root: string;
  chunk_index: number;
  role: string;
  content: string;
  timestamp: string;
  referenced_files: string | null;
}

export interface SessionChunkInput {
  session_id: string;
  project_root: string;
  chunk_index: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  referenced_files?: string[];
}

export interface SessionSearchResult {
  chunk_id: number;
  session_id: string;
  role: string;
  content: string;
  timestamp: string;
  referenced_files: string | null;
  rank: number;
}

// ════════════════════════════════════════════════════════════════════════
// SCHEMA
// ════════════════════════════════════════════════════════════════════════

const DECISIONS_DDL = `
CREATE TABLE IF NOT EXISTS decisions (
    id              INTEGER PRIMARY KEY,
    title           TEXT NOT NULL,
    content         TEXT NOT NULL,
    type            TEXT NOT NULL,
    project_root    TEXT NOT NULL,
    service_name    TEXT,
    symbol_id       TEXT,
    file_path       TEXT,
    tags            TEXT,
    valid_from      TEXT NOT NULL,
    valid_until     TEXT,
    session_id      TEXT,
    source          TEXT NOT NULL DEFAULT 'manual',
    confidence      REAL NOT NULL DEFAULT 1.0,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_root);
CREATE INDEX IF NOT EXISTS idx_decisions_service ON decisions(service_name);
CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(type);
CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON decisions(symbol_id);
CREATE INDEX IF NOT EXISTS idx_decisions_file ON decisions(file_path);
CREATE INDEX IF NOT EXISTS idx_decisions_valid ON decisions(valid_from, valid_until);

-- FTS5 virtual table for full-text search over decisions
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
    title,
    content,
    tags,
    content=decisions,
    content_rowid=id,
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
    INSERT INTO decisions_fts(rowid, title, content, tags)
    VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, title, content, tags)
    VALUES ('delete', old.id, old.title, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
    INSERT INTO decisions_fts(decisions_fts, rowid, title, content, tags)
    VALUES ('delete', old.id, old.title, old.content, old.tags);
    INSERT INTO decisions_fts(rowid, title, content, tags)
    VALUES (new.id, new.title, new.content, new.tags);
END;

-- Mined sessions tracking (prevent re-mining)
CREATE TABLE IF NOT EXISTS mined_sessions (
    session_path    TEXT PRIMARY KEY,
    mined_at        TEXT NOT NULL,
    decisions_found INTEGER NOT NULL DEFAULT 0
);

-- ════════════════════════════════════════════════════════════════
-- SESSION CONTENT CHUNKS — cross-session semantic search
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS session_chunks (
    id              INTEGER PRIMARY KEY,
    session_id      TEXT NOT NULL,
    project_root    TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    timestamp       TEXT NOT NULL,
    /** Comma-separated file paths referenced in this chunk */
    referenced_files TEXT,
    UNIQUE(session_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_project ON session_chunks(project_root);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON session_chunks(session_id);

-- FTS5 for session content search
CREATE VIRTUAL TABLE IF NOT EXISTS session_chunks_fts USING fts5(
    content,
    content=session_chunks,
    content_rowid=id,
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON session_chunks BEGIN
    INSERT INTO session_chunks_fts(rowid, content)
    VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON session_chunks BEGIN
    INSERT INTO session_chunks_fts(session_chunks_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
END;
`;

// ════════════════════════════════════════════════════════════════════════
// STORE
// ════════════════════════════════════════════════════════════════════════

export class DecisionStore {
  public readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.preMigrate();
    this.db.exec(DECISIONS_DDL);
    this.migrate();
    logger.debug({ dbPath }, 'Decision store initialized');
  }

  /**
   * Fix legacy schemas BEFORE DDL runs — prevents crashes when
   * CREATE INDEX references columns that don't exist in old tables.
   */
  private preMigrate(): void {
    const hasTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions'")
      .get();
    if (hasTable) {
      const cols = (this.db.pragma('table_info(decisions)') as Array<{ name: string }>).map(c => c.name);
      if (!cols.includes('service_name')) {
        this.db.exec('ALTER TABLE decisions ADD COLUMN service_name TEXT');
        logger.info('Pre-migration: added service_name column to decisions table');
      }
    }
  }

  private migrate(): void {
    // (service_name migration now handled in preMigrate)
  }

  close(): void {
    this.db.close();
  }

  // ── CRUD ───────────────────────────────────────────────────────────

  addDecision(input: DecisionInput): DecisionRow {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO decisions (title, content, type, project_root, service_name, symbol_id, file_path, tags, valid_from, session_id, source, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      input.title,
      input.content,
      input.type,
      input.project_root,
      input.service_name ?? null,
      input.symbol_id ?? null,
      input.file_path ?? null,
      input.tags ? JSON.stringify(input.tags) : null,
      input.valid_from ?? now,
      input.session_id ?? null,
      input.source ?? 'manual',
      input.confidence ?? 1.0,
      now,
    );
    return this.getDecision(info.lastInsertRowid as number)!;
  }

  addDecisions(inputs: DecisionInput[]): number {
    const insertMany = this.db.transaction((items: DecisionInput[]) => {
      let count = 0;
      for (const input of items) {
        this.addDecision(input);
        count++;
      }
      return count;
    });
    return insertMany(inputs);
  }

  getDecision(id: number): DecisionRow | undefined {
    return this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as DecisionRow | undefined;
  }

  invalidateDecision(id: number, validUntil?: string): boolean {
    const until = validUntil ?? new Date().toISOString();
    const info = this.db.prepare('UPDATE decisions SET valid_until = ? WHERE id = ? AND valid_until IS NULL').run(until, id);
    return info.changes > 0;
  }

  deleteDecision(id: number): boolean {
    const info = this.db.prepare('DELETE FROM decisions WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // ── QUERY ──────────────────────────────────────────────────────────

  queryDecisions(query: DecisionQuery): DecisionRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.project_root) {
      conditions.push('d.project_root = ?');
      params.push(query.project_root);
    }
    if (query.service_name) {
      conditions.push('d.service_name = ?');
      params.push(query.service_name);
    }
    if (query.type) {
      conditions.push('d.type = ?');
      params.push(query.type);
    }
    if (query.symbol_id) {
      conditions.push('d.symbol_id = ?');
      params.push(query.symbol_id);
    }
    if (query.file_path) {
      conditions.push('d.file_path = ?');
      params.push(query.file_path);
    }
    if (query.tag) {
      conditions.push("d.tags LIKE '%' || ? || '%'");
      params.push(query.tag);
    }
    if (!query.include_invalidated) {
      if (query.as_of) {
        conditions.push('d.valid_from <= ? AND (d.valid_until IS NULL OR d.valid_until > ?)');
        params.push(query.as_of, query.as_of);
      } else {
        conditions.push('d.valid_until IS NULL');
      }
    }

    // FTS search — join with FTS table
    if (query.search) {
      conditions.push('d.id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?)');
      params.push(query.search);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const sql = `SELECT d.* FROM decisions d ${where} ORDER BY d.valid_from DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as DecisionRow[];
  }

  // ── TIMELINE ───────────────────────────────────────────────────────

  getTimeline(opts: {
    project_root?: string;
    symbol_id?: string;
    file_path?: string;
    limit?: number;
  }): DecisionTimelineEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.project_root) {
      conditions.push('project_root = ?');
      params.push(opts.project_root);
    }
    if (opts.symbol_id) {
      conditions.push('symbol_id = ?');
      params.push(opts.symbol_id);
    }
    if (opts.file_path) {
      conditions.push('file_path = ?');
      params.push(opts.file_path);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;

    const sql = `
      SELECT id, title, type, valid_from, valid_until,
             CASE WHEN valid_until IS NULL THEN 1 ELSE 0 END as is_active
      FROM decisions ${where}
      ORDER BY valid_from ASC
      LIMIT ?
    `;
    params.push(limit);

    return this.db.prepare(sql).all(...params) as DecisionTimelineEntry[];
  }

  // ── STATS ──────────────────────────────────────────────────────────

  getStats(projectRoot?: string): {
    total: number;
    active: number;
    invalidated: number;
    by_type: Record<string, number>;
    by_source: Record<string, number>;
  } {
    const filter = projectRoot ? ' WHERE project_root = ?' : '';
    const params = projectRoot ? [projectRoot] : [];

    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM decisions${filter}`).get(...params) as { c: number }).c;
    const active = (this.db.prepare(`SELECT COUNT(*) as c FROM decisions${filter}${filter ? ' AND' : ' WHERE'} valid_until IS NULL`).get(...params) as { c: number }).c;

    const typeRows = this.db.prepare(`SELECT type, COUNT(*) as c FROM decisions${filter} GROUP BY type`).all(...params) as Array<{ type: string; c: number }>;
    const by_type: Record<string, number> = {};
    for (const r of typeRows) by_type[r.type] = r.c;

    const sourceRows = this.db.prepare(`SELECT source, COUNT(*) as c FROM decisions${filter} GROUP BY source`).all(...params) as Array<{ source: string; c: number }>;
    const by_source: Record<string, number> = {};
    for (const r of sourceRows) by_source[r.source] = r.c;

    return { total, active, invalidated: total - active, by_type, by_source };
  }

  // ── MINED SESSIONS ────────────────────────────────────────────────

  isSessionMined(sessionPath: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM mined_sessions WHERE session_path = ?').get(sessionPath);
    return !!row;
  }

  markSessionMined(sessionPath: string, decisionsFound: number): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO mined_sessions (session_path, mined_at, decisions_found) VALUES (?, ?, ?)',
    ).run(sessionPath, new Date().toISOString(), decisionsFound);
  }

  getMinedSessionCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM mined_sessions').get() as { c: number }).c;
  }

  // ── CODE-AWARE QUERIES ────────────────────────────────────────────

  /** Get all decisions linked to a specific symbol */
  getDecisionsForSymbol(symbolId: string, activeOnly = true): DecisionRow[] {
    const filter = activeOnly ? ' AND valid_until IS NULL' : '';
    return this.db.prepare(`SELECT * FROM decisions WHERE symbol_id = ?${filter} ORDER BY valid_from DESC`).all(symbolId) as DecisionRow[];
  }

  /** Get all decisions linked to a specific file */
  getDecisionsForFile(filePath: string, activeOnly = true): DecisionRow[] {
    const filter = activeOnly ? ' AND valid_until IS NULL' : '';
    return this.db.prepare(`SELECT * FROM decisions WHERE file_path = ?${filter} ORDER BY valid_from DESC`).all(filePath) as DecisionRow[];
  }

  /** Get decisions linked to any file matching a pattern (e.g., 'src/auth/%') */
  getDecisionsForPath(pathPattern: string, activeOnly = true): DecisionRow[] {
    const filter = activeOnly ? ' AND valid_until IS NULL' : '';
    return this.db.prepare(`SELECT * FROM decisions WHERE file_path LIKE ?${filter} ORDER BY valid_from DESC`).all(pathPattern) as DecisionRow[];
  }

  /** Get all decisions for a specific service/federation within a project */
  getDecisionsForService(serviceName: string, projectRoot?: string, activeOnly = true): DecisionRow[] {
    const filter = activeOnly ? ' AND valid_until IS NULL' : '';
    if (projectRoot) {
      return this.db.prepare(`SELECT * FROM decisions WHERE service_name = ? AND project_root = ?${filter} ORDER BY valid_from DESC`).all(serviceName, projectRoot) as DecisionRow[];
    }
    return this.db.prepare(`SELECT * FROM decisions WHERE service_name = ?${filter} ORDER BY valid_from DESC`).all(serviceName) as DecisionRow[];
  }

  /** Get all distinct service names in a project */
  getServiceNames(projectRoot: string): string[] {
    const rows = this.db.prepare('SELECT DISTINCT service_name FROM decisions WHERE project_root = ? AND service_name IS NOT NULL').all(projectRoot) as Array<{ service_name: string }>;
    return rows.map(r => r.service_name);
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
    const row = this.db.prepare('SELECT 1 FROM session_chunks WHERE session_id = ? LIMIT 1').get(sessionId);
    return !!row;
  }

  searchSessions(query: string, opts: {
    project_root?: string;
    limit?: number;
  } = {}): SessionSearchResult[] {
    const limit = opts.limit ?? 20;
    if (opts.project_root) {
      return this.db.prepare(`
        SELECT sc.id as chunk_id, sc.session_id, sc.role, sc.content, sc.timestamp,
               sc.referenced_files, rank
        FROM session_chunks_fts fts
        JOIN session_chunks sc ON sc.id = fts.rowid
        WHERE session_chunks_fts MATCH ?
          AND sc.project_root = ?
        ORDER BY rank
        LIMIT ?
      `).all(query, opts.project_root, limit) as SessionSearchResult[];
    }
    return this.db.prepare(`
      SELECT sc.id as chunk_id, sc.session_id, sc.role, sc.content, sc.timestamp,
             sc.referenced_files, rank
      FROM session_chunks_fts fts
      JOIN session_chunks sc ON sc.id = fts.rowid
      WHERE session_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as SessionSearchResult[];
  }

  getSessionChunkCount(projectRoot?: string): number {
    if (projectRoot) {
      return (this.db.prepare('SELECT COUNT(*) as c FROM session_chunks WHERE project_root = ?').get(projectRoot) as { c: number }).c;
    }
    return (this.db.prepare('SELECT COUNT(*) as c FROM session_chunks').get() as { c: number }).c;
  }

  getIndexedSessionIds(projectRoot?: string): string[] {
    const filter = projectRoot ? ' WHERE project_root = ?' : '';
    const params = projectRoot ? [projectRoot] : [];
    const rows = this.db.prepare(`SELECT DISTINCT session_id FROM session_chunks${filter}`).all(...params) as Array<{ session_id: string }>;
    return rows.map(r => r.session_id);
  }
}
