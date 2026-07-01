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
import { restrictDbPerms } from '../shared/db-perms.js';
import { relativizeUnderRoot } from '../utils/path-relativize.js';
import { computeConfidence } from './decision-confidence.js';
import type { AuditLogger } from './decision-audit-log.js';
import { titleSimilarity } from './decision-clusterer.js';
import { type ConsolidationVerdict, mergeContents, mergeTags } from './decision-consolidator.js';
import { computeHeat, heatDecayMultiplier } from './heat.js';
import { MemoOperations } from './decision-store-memo-ops.js';
import { ClusterOperations } from './decision-store-cluster-ops.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

// Shared types live in `decision-types.ts` so helper modules (clusterer,
// confidence scorer, consolidator, tuner) can import them without closing
// a cycle back through this store. Re-export here to preserve the public
// API — external callers keep importing from `./decision-store.js`.
export type {
  DecisionType,
  DecisionRow,
  DecisionInput,
  ClusterRow,
  ClusterInput,
  ClusterQuery,
  ProjectMemoRow,
} from './decision-types.js';
import type {
  DecisionType,
  DecisionRow,
  DecisionInput,
  ClusterRow,
  ClusterInput,
  ClusterQuery,
  ProjectMemoRow,
} from './decision-types.js';

export interface DecisionQuery {
  project_root?: string;
  /** Filter by subproject name within the project */
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
  /**
   * Git-branch filter. Three modes:
   *   - `'all'`           — every branch (no filter)
   *   - `string` (other)  — only that branch + branch-agnostic (NULL) rows
   *   - `null`            — only branch-agnostic (NULL) rows
   *   - omitted/`undefined` — no filter (back-compat: equivalent to `'all'`)
   * Callers that want "current branch + NULL" should resolve the branch first
   * (see `getCurrentBranch`) and pass the resolved name.
   */
  git_branch?: string | null | 'all';
  /**
   * Review-queue filter (memoir-style confidence tiers).
   * Default behaviour returns auto-approved (`NULL`) and explicitly-approved
   * rows so the review queue stays out of regular queries.
   *
   *   - omitted              — only `NULL` + `'approved'` rows
   *   - `include_pending`    — convenience flag; when true also returns `'pending'`
   *   - `review_status`      — restrict to that exact status (overrides default)
   */
  include_pending?: boolean;
  review_status?: 'pending' | 'approved' | 'rejected';
  /**
   * Result ordering.
   *   - `'recency'` (default)   — `valid_from DESC` (existing behaviour)
   *   - `'created_at'`          — `created_at DESC`
   *   - `'heat'`                — computed in JS via `computeHeat`; rows fetched
   *                               with a safety cap (limit * 3, capped at 500)
   *                               and sorted before truncation. Falls back to
   *                               recency when the heat subsystem is disabled.
   */
  order_by?: 'recency' | 'heat' | 'created_at';
  /**
   * Heat scoring overrides for `order_by='heat'`. Optional — defaults come
   * from `memory.heat.*` config or hard-coded defaults in `computeHeat`.
   */
  heat_half_life_days?: number;
  heat_freshness_days?: number;
  /**
   * When `order_by='heat'` is requested but the heat subsystem is disabled
   * (config flag), callers can pass this flag to opt-out of the graceful
   * fallback and surface an explicit error. Reserved for future use.
   */
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

// Cluster + memo row/query shapes moved to `decision-types.ts` so the
// extracted persistence modules can import them without closing an import
// cycle back through this store. Re-exported here for public-API back-compat.

// ── PROJECT MEMOS (L3 orientation digest) ─────────────────────────────
//
// A project memo is a 250-400 word LLM-synthesised Markdown document that
// captures the project's architectural personality: dominant tech choices,
// conventions, in-flight work, named subsystems. It's the L3 narrative
// overlay over L1 (raw decisions) and L2 (clusters) — what a senior
// engineer would say in a 30-second "what is this project about" pitch.
//
// Only the LATEST row per (project_root, service_name) is read by surfaces.
// Old rows are retained for history (regenerate inserts a new row with
// version+1 rather than overwriting).

/**
 * P2.5 — confidence-weight learning corpus. One row per approve/reject
 * toggle, joined with the parent decision via decision_id.
 */
export interface ReviewEventRow {
  id: number;
  decision_id: number;
  action: 'approve' | 'reject';
  /** JSON-encoded ConfidenceSignals payload. */
  signals_at_decision: string;
  confidence_at_decision: number;
  reviewed_at: string;
  reviewer: string | null;
}

/**
 * Persisted per-project background-scheduler bookkeeping. Restored on
 * daemon start so a restart does NOT re-run every stage on tick 1.
 */
export interface SchedulerStateRow {
  project_root: string;
  last_mine_at: number | null;
  last_cluster_at: number | null;
  last_memo_at: number | null;
  last_tune_at: number | null;
  last_tune_event_count: number | null;
  consecutive_failures: number;
  updated_at: string;
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
    git_branch      TEXT,
    review_status   TEXT,
    created_at      TEXT NOT NULL,
    hit_count       INTEGER NOT NULL DEFAULT 0,
    last_hit_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_root);
CREATE INDEX IF NOT EXISTS idx_decisions_service ON decisions(service_name);
CREATE INDEX IF NOT EXISTS idx_decisions_type ON decisions(type);
CREATE INDEX IF NOT EXISTS idx_decisions_symbol ON decisions(symbol_id);
CREATE INDEX IF NOT EXISTS idx_decisions_file ON decisions(file_path);
CREATE INDEX IF NOT EXISTS idx_decisions_valid ON decisions(valid_from, valid_until);
CREATE INDEX IF NOT EXISTS idx_decisions_branch ON decisions(git_branch);
CREATE INDEX IF NOT EXISTS idx_decisions_file_branch ON decisions(file_path, git_branch);
CREATE INDEX IF NOT EXISTS idx_decisions_review_status ON decisions(review_status);

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
    session_path     TEXT PRIMARY KEY,
    mined_at         TEXT NOT NULL,
    decisions_found  INTEGER NOT NULL DEFAULT 0,
    -- Incremental cursor (P2.3): re-mining a previously-mined file resumes
    -- from cursor_offset instead of re-parsing the whole file. last_size +
    -- last_modified_ms detect rotation/truncation and let unchanged files
    -- skip parsing entirely. preMigrate ALTERs upgrade legacy DBs.
    cursor_offset    INTEGER NOT NULL DEFAULT 0,
    last_size        INTEGER NOT NULL DEFAULT 0,
    last_modified_ms INTEGER NOT NULL DEFAULT 0
);

-- Mined provider sessions tracking (P2.3 extension to providers like Hermes/Codex).
--
-- Why a sibling table rather than overloading mined_sessions:
--   - Provider sessions (Hermes) are SQLite-backed — byte offsets don't apply.
--     We track a message-id / timestamp cursor instead.
--   - The session "path" is a synthetic key like "hermes:<id>" or "codex:<id>",
--     not a filesystem path, so reusing the same PRIMARY KEY namespace would
--     conflate two semantically distinct things.
--   - Provider rotation/truncation semantics differ: SQLite rows can be deleted
--     in-place, not just appended like a JSONL file.
--
-- Cursor primitive: last_timestamp_ms (highest message timestamp consumed) +
-- last_message_id (string, for deterministic ordering tie-breaks). On a re-pass
-- we skip every message whose (ts, id) is ≤ the cursor. last_seen_size +
-- last_seen_modified_ms detect SessionHandle-level rotation (DB shrank → restart).
CREATE TABLE IF NOT EXISTS mined_provider_sessions (
    session_key          TEXT PRIMARY KEY,        -- e.g. "hermes:<id>" or "codex:<id>"
    mined_at             TEXT NOT NULL,
    decisions_found      INTEGER NOT NULL DEFAULT 0,
    last_timestamp_ms    INTEGER NOT NULL DEFAULT 0,
    last_message_id      TEXT NOT NULL DEFAULT '',
    last_seen_size       INTEGER NOT NULL DEFAULT 0,
    last_seen_modified_ms INTEGER NOT NULL DEFAULT 0
);

-- ════════════════════════════════════════════════════════════════
-- LLM EXTRACTION CACHE — avoid re-paying LLM tokens on re-mining
-- ════════════════════════════════════════════════════════════════
-- Caches raw extracted JSON for a (session_id, content_sha, model) triple.
-- The content_sha keys the cache on the privacy-stripped transcript so a
-- session that hasn't changed (and a model that hasn't swapped) returns the
-- cached extraction. Different models against the same content live as
-- separate rows so a model upgrade transparently re-extracts.
CREATE TABLE IF NOT EXISTS llm_extraction_cache (
    session_id      TEXT NOT NULL,
    content_sha     TEXT NOT NULL,
    extracted_json  TEXT NOT NULL,
    model           TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (session_id, content_sha, model)
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

-- ════════════════════════════════════════════════════════════════
-- DECISION CLUSTERS (P1.1) — L2 thematic layer over raw decisions
-- ════════════════════════════════════════════════════════════════
-- A cluster is a short noun-phrase label + 1-3 sentence summary that
-- groups topically-related decisions. Produced by the LLM clusterer in
-- src/memory/decision-clusterer.ts. Cluster ids are stable across
-- re-runs via title similarity (see titleSimilarity + the merge logic
-- in the build_decision_clusters tool handler).
--
-- decision_cluster_members is the join table (one row per decision in
-- a cluster). The FK to decisions has ON DELETE CASCADE so dropping a
-- decision automatically drops its membership rows.
CREATE TABLE IF NOT EXISTS decision_clusters (
    id              INTEGER PRIMARY KEY,
    project_root    TEXT NOT NULL,
    service_name    TEXT,
    title           TEXT NOT NULL,
    summary         TEXT NOT NULL,
    tags            TEXT,
    primary_type    TEXT,
    decision_count  INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clusters_project ON decision_clusters(project_root);
CREATE INDEX IF NOT EXISTS idx_clusters_service ON decision_clusters(service_name);
CREATE INDEX IF NOT EXISTS idx_clusters_updated ON decision_clusters(updated_at);

CREATE TABLE IF NOT EXISTS decision_cluster_members (
    cluster_id      INTEGER NOT NULL REFERENCES decision_clusters(id) ON DELETE CASCADE,
    decision_id     INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    PRIMARY KEY (cluster_id, decision_id)
);
CREATE INDEX IF NOT EXISTS idx_cluster_members_decision ON decision_cluster_members(decision_id);

-- FTS5 virtual table for full-text search over cluster titles + summaries
CREATE VIRTUAL TABLE IF NOT EXISTS decision_clusters_fts USING fts5(
    title,
    summary,
    tags,
    content=decision_clusters,
    content_rowid=id,
    tokenize='porter unicode61'
);

-- Triggers to keep cluster FTS in sync
CREATE TRIGGER IF NOT EXISTS decision_clusters_ai AFTER INSERT ON decision_clusters BEGIN
    INSERT INTO decision_clusters_fts(rowid, title, summary, tags)
    VALUES (new.id, new.title, new.summary, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS decision_clusters_ad AFTER DELETE ON decision_clusters BEGIN
    INSERT INTO decision_clusters_fts(decision_clusters_fts, rowid, title, summary, tags)
    VALUES ('delete', old.id, old.title, old.summary, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS decision_clusters_au AFTER UPDATE ON decision_clusters BEGIN
    INSERT INTO decision_clusters_fts(decision_clusters_fts, rowid, title, summary, tags)
    VALUES ('delete', old.id, old.title, old.summary, old.tags);
    INSERT INTO decision_clusters_fts(rowid, title, summary, tags)
    VALUES (new.id, new.title, new.summary, new.tags);
END;

-- ════════════════════════════════════════════════════════════════
-- PROJECT MEMOS (L3 orientation digest)
-- ════════════════════════════════════════════════════════════════
-- LLM-synthesised Markdown orientation digest for a project (or per
-- service). Only the LATEST row per (project_root, service_name) is
-- read by surfaces — old rows are retained for history (regenerate
-- inserts a new row with version+1).
CREATE TABLE IF NOT EXISTS project_memos (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    project_root            TEXT NOT NULL,
    service_name            TEXT,
    memo_md                 TEXT NOT NULL,
    version                 INTEGER NOT NULL DEFAULT 1,
    model                   TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    last_decision_id        INTEGER,
    decisions_at_generation INTEGER NOT NULL DEFAULT 0,
    clusters_at_generation  INTEGER NOT NULL DEFAULT 0,
    estimated_tokens        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_project_memos_scope
    ON project_memos(project_root, service_name);

-- ════════════════════════════════════════════════════════════════
-- DECISION REVIEWS (P2.5) — confidence-weight learning corpus
-- ════════════════════════════════════════════════════════════════
-- Every approve/reject toggle on a decision drops one row here so the
-- weight tuner can re-fit the confidence scorer over actual reviewer
-- feedback. signals_at_decision is a JSON blob of the features the
-- scorer used at capture time (has_code_ref, content_length, tag_count,
-- type, has_service) — recorded at review time, not capture time, so the
-- review row keeps a self-contained training example even if the
-- decision body gets edited later. FK cascade keeps the table clean
-- when a decision is hard-deleted.
CREATE TABLE IF NOT EXISTS decision_reviews (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id              INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    action                   TEXT NOT NULL CHECK(action IN ('approve','reject')),
    signals_at_decision      TEXT NOT NULL,
    confidence_at_decision   REAL NOT NULL,
    reviewed_at              TEXT NOT NULL,
    reviewer                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_decision_reviews_action ON decision_reviews(action);
CREATE INDEX IF NOT EXISTS idx_decision_reviews_decision ON decision_reviews(decision_id);

-- ════════════════════════════════════════════════════════════════
-- SCHEDULER STATE — durable per-project cooldown bookkeeping
-- ════════════════════════════════════════════════════════════════
-- The background MemoryScheduler keeps per-project cooldown timestamps
-- (lastMineAt/lastClusterAt/lastMemoAt/lastTuneAt) plus the
-- consecutiveFailures back-off counter and a lastTuneEventCount baseline
-- in memory. Persisting them here lets a daemon restart skip stages that
-- were already run on the previous boot — avoiding a thundering herd of
-- expensive LLM-backed mine/cluster/memo/tune calls on the first tick.
CREATE TABLE IF NOT EXISTS scheduler_state (
    project_root            TEXT NOT NULL,
    last_mine_at            INTEGER,
    last_cluster_at         INTEGER,
    last_memo_at            INTEGER,
    last_tune_at            INTEGER,
    last_tune_event_count   INTEGER,
    consecutive_failures    INTEGER NOT NULL DEFAULT 0,
    updated_at              TEXT NOT NULL,
    PRIMARY KEY (project_root)
);
`;

// ════════════════════════════════════════════════════════════════════════
// STORE
// ════════════════════════════════════════════════════════════════════════

export class DecisionStore {
  public readonly db: Database.Database;
  /**
   * Optional day-bucketed JSONL audit logger. When set, every successful
   * add/update/invalidate is mirrored to the configured directory. Audit
   * writes are best-effort — failures never bubble out of the mutation
   * methods.
   */
  private auditLogger: AuditLogger | null;
  /**
   * Bounded retention for `project_memos`: keep at most N rows per
   * (project_root, service_name) scope. The retention prune runs in the
   * same transaction as the INSERT inside `saveProjectMemo`, so the table
   * can never exceed `historyLimit * scopes` at rest. Defaults to 10 — the
   * historical UI default for `listProjectMemos`.
   */
  private memoHistoryLimit: number;
  /** Project-memo persistence, extracted from this class (god-class decomposition). */
  private memoOps: MemoOperations;
  /** Decision-cluster persistence, extracted from this class (god-class decomposition). */
  private clusterOps: ClusterOperations;

  constructor(
    dbPath: string,
    opts?: {
      readonly?: boolean;
      auditLogger?: AuditLogger | null;
      memoHistoryLimit?: number;
    },
  ) {
    this.db = new Database(dbPath, { readonly: opts?.readonly ?? false });
    this.auditLogger = opts?.auditLogger ?? null;
    this.memoHistoryLimit = Math.max(1, opts?.memoHistoryLimit ?? 10);
    this.memoOps = new MemoOperations(this.db, this.memoHistoryLimit);
    this.clusterOps = new ClusterOperations(this.db);
    if (opts?.readonly) {
      this.db.pragma('busy_timeout = 5000');
      logger.debug({ dbPath, readonly: true }, 'Decision store opened (readonly)');
    } else {
      restrictDbPerms(dbPath);
      this.db.pragma('journal_mode = WAL');
      // Bound WAL/journal growth: long-running daemons accumulating decisions
      // would otherwise grow `*-wal` unbounded between checkpoints. 100 MiB is
      // enough headroom for normal write bursts but caps worst-case disk use.
      this.db.pragma(`journal_size_limit = ${100 * 1024 * 1024}`);
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.preMigrate();
      this.db.exec(DECISIONS_DDL);
      this.migrate();
      this.scheduleWalCheckpoint();
      logger.debug({ dbPath }, 'Decision store initialized');
    }
  }

  /**
   * Best-effort audit-log emit. Wrapped in try/catch so a failed JSONL
   * write never affects the underlying SQLite mutation. No-op when no
   * logger is configured.
   */
  private auditEmit(
    op: 'add' | 'update' | 'invalidate',
    decisionId: number,
    row?: { title?: string | null; type?: string | null },
  ): void {
    if (!this.auditLogger) return;
    try {
      this.auditLogger.log({
        op,
        decision_id: decisionId,
        title: row?.title ?? undefined,
        type: row?.type ?? undefined,
        ts: new Date().toISOString(),
      });
    } catch (err) {
      logger.debug?.(
        { err: (err as Error).message },
        'decision audit log write failed (non-fatal)',
      );
    }
  }

  private checkpointTimer: NodeJS.Timeout | null = null;

  /**
   * Periodic `wal_checkpoint(TRUNCATE)` keeps `*-wal` from growing forever in
   * a long-running daemon. SQLite auto-checkpoints on the writer thread, but
   * only when the WAL crosses 1000 frames — heavy read traffic with light
   * writes can stall a checkpoint indefinitely. TRUNCATE truncates the WAL
   * back to zero after a successful checkpoint.
   */
  private scheduleWalCheckpoint(): void {
    if (this.checkpointTimer !== null) return;
    const tick = () => {
      try {
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (err) {
        // Non-fatal: another writer holds the lock, or DB just closed.
        logger.debug?.({ err: (err as Error).message }, 'wal_checkpoint failed');
      }
    };
    // 5 minutes — short enough to keep WAL bounded, long enough to amortise
    // checkpoint cost across many writes.
    this.checkpointTimer = setInterval(tick, 5 * 60 * 1000);
    // Don't pin the event loop on the checkpoint timer.
    this.checkpointTimer.unref?.();
  }

  private cancelWalCheckpoint(): void {
    if (this.checkpointTimer === null) return;
    clearInterval(this.checkpointTimer);
    this.checkpointTimer = null;
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
      const cols = (this.db.pragma('table_info(decisions)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
      if (!cols.includes('service_name')) {
        this.db.exec('ALTER TABLE decisions ADD COLUMN service_name TEXT');
        logger.info('Pre-migration: added service_name column to decisions table');
      }
      // Branch-aware decision memory: existing rows backfill to NULL
      // (= branch-agnostic). Idempotent: ALTER TABLE only runs when column missing.
      if (!cols.includes('git_branch')) {
        this.db.exec('ALTER TABLE decisions ADD COLUMN git_branch TEXT');
        logger.info('Pre-migration: added git_branch column to decisions table');
      }
      // Memoir-style review queue: existing rows backfill to NULL
      // (= auto-approved / legacy, visible by default). Idempotent: ALTER TABLE
      // only runs when the column is missing — SQLite has no native
      // "ADD COLUMN IF NOT EXISTS", so we probe via PRAGMA table_info first.
      if (!cols.includes('review_status')) {
        this.db.exec('ALTER TABLE decisions ADD COLUMN review_status TEXT');
        logger.info('Pre-migration: added review_status column to decisions table');
      }
      // Heat / time-decay scoring (P2.1): track recall frequency and recency
      // so frequently-used decisions surface higher and stale ones fade.
      // Idempotent: ALTER TABLE only runs when the column is missing —
      // SQLite has no native "ADD COLUMN IF NOT EXISTS".
      if (!cols.includes('hit_count')) {
        this.db.exec('ALTER TABLE decisions ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0');
        logger.info('Pre-migration: added hit_count column to decisions table');
      }
      if (!cols.includes('last_hit_at')) {
        this.db.exec('ALTER TABLE decisions ADD COLUMN last_hit_at TEXT');
        logger.info('Pre-migration: added last_hit_at column to decisions table');
      }
    }

    // Incremental session-mining cursor (P2.3): augment the binary
    // mined/unmined `mined_sessions` row with a byte-offset cursor so a
    // long-running session file (Claude Code appends continuously) can be
    // re-mined for only the appended portion. Mirrors the existing
    // PRAGMA-table_info probe pattern: ALTER TABLE only runs when the
    // column is missing — SQLite has no native ADD COLUMN IF NOT EXISTS.
    const hasMinedSessions = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mined_sessions'")
      .get();
    if (hasMinedSessions) {
      const minedCols = (
        this.db.pragma('table_info(mined_sessions)') as Array<{ name: string }>
      ).map((c) => c.name);
      if (!minedCols.includes('cursor_offset')) {
        this.db.exec(
          'ALTER TABLE mined_sessions ADD COLUMN cursor_offset INTEGER NOT NULL DEFAULT 0',
        );
        logger.info('Pre-migration: added cursor_offset column to mined_sessions table');
      }
      if (!minedCols.includes('last_size')) {
        this.db.exec('ALTER TABLE mined_sessions ADD COLUMN last_size INTEGER NOT NULL DEFAULT 0');
        logger.info('Pre-migration: added last_size column to mined_sessions table');
      }
      if (!minedCols.includes('last_modified_ms')) {
        this.db.exec(
          'ALTER TABLE mined_sessions ADD COLUMN last_modified_ms INTEGER NOT NULL DEFAULT 0',
        );
        logger.info('Pre-migration: added last_modified_ms column to mined_sessions table');
      }
    }
  }

  private migrate(): void {
    // (service_name migration now handled in preMigrate)
    // v2: add updated_at column (Unix ms) for incremental refresh.
    const hasUpdatedAt = (this.db.pragma('table_info(decisions)') as Array<{ name: string }>).some(
      (c) => c.name === 'updated_at',
    );
    if (!hasUpdatedAt) {
      this.db.exec(`
        ALTER TABLE decisions ADD COLUMN updated_at INTEGER;
        UPDATE decisions SET updated_at = strftime('%s','now')*1000 WHERE updated_at IS NULL;
      `);
      logger.info('Migration: added updated_at column to decisions table');
    }
  }

  /**
   * Update mutable fields on an existing decision.
   * Returns the updated row, or undefined when the id does not exist.
   */
  updateDecision(
    id: number,
    fields: Partial<
      Omit<
        Pick<
          DecisionRow,
          | 'title'
          | 'content'
          | 'type'
          | 'symbol_id'
          | 'file_path'
          | 'tags'
          | 'source'
          | 'confidence'
        >,
        'tags'
      > & {
        /** Either a string[] (will be JSON-stringified) or a raw JSON string. */
        tags?: string[] | string | null;
      }
    >,
  ): DecisionRow | undefined {
    const cols = Object.keys(fields) as Array<keyof typeof fields>;
    if (cols.length === 0) return this.getDecision(id);

    const setClauses = cols.map((k) => `${k} = ?`).join(', ');
    const values = cols.map((k) => {
      if (k === 'tags' && Array.isArray(fields[k])) return JSON.stringify(fields[k]);
      return fields[k] ?? null;
    });

    this.db
      .prepare(
        `UPDATE decisions SET ${setClauses}, updated_at = strftime('%s','now')*1000 WHERE id = ?`,
      )
      .run(...values, id);

    const updated = this.getDecision(id);
    if (updated) {
      this.auditEmit('update', id, { title: updated.title, type: updated.type });
    }
    return updated;
  }

  close(): void {
    this.cancelWalCheckpoint();
    // Final checkpoint before close so the next opener sees an empty WAL.
    try {
      if (this.db.open) this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* best-effort */
    }
    this.db.close();
  }

  // ── CRUD ───────────────────────────────────────────────────────────

  /**
   * Insert a decision.
   *
   * When `opts.supersede` is true, any active decision sharing the SAME
   * state key (project_root + type + code anchor) is auto-invalidated with
   * `valid_until = now` before the new row lands — "state-key supersession"
   * (Task 11). The conflict heuristic is deliberately conservative:
   *   - same `project_root`
   *   - same `type`
   *   - same code anchor: `symbol_id` when the new row has one (file-only rows
   *     never collide with symbol-anchored rows), else `file_path`.
   * Rows with no anchor at all never supersede anything (no state key).
   *
   * For the caller-facing variant that also returns the superseded ids, use
   * `addDecisionWithSupersession`.
   */
  addDecision(input: DecisionInput, opts?: { supersede?: boolean }): DecisionRow {
    if (opts?.supersede) {
      this.supersedeConflicting(input);
    }
    const now = new Date().toISOString();
    // Canonicalise file_path to repo-relative when it sits inside project_root.
    // Stops absolute /Users/<dev>/<host-only>/... paths leaking into the
    // decision store and downstream MCP responses (mempalace #1325).
    const canonFilePath = input.project_root
      ? (relativizeUnderRoot(input.file_path, input.project_root) ?? null)
      : (input.file_path ?? null);
    const stmt = this.db.prepare(`
      INSERT INTO decisions (title, content, type, project_root, service_name, symbol_id, file_path, tags, valid_from, session_id, source, confidence, git_branch, review_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now')*1000)
    `);
    const info = stmt.run(
      input.title,
      input.content,
      input.type,
      input.project_root,
      input.service_name ?? null,
      input.symbol_id ?? null,
      canonFilePath,
      input.tags ? JSON.stringify(input.tags) : null,
      input.valid_from ?? now,
      input.session_id ?? null,
      input.source ?? 'manual',
      input.confidence ?? 1.0,
      input.git_branch ?? null,
      input.review_status ?? null,
      now,
    );
    const newId = info.lastInsertRowid as number;
    this.auditEmit('add', newId, { title: input.title, type: input.type });
    return this.getDecision(newId)!;
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

  /**
   * Insert a decision with auto-supersession, returning both the new row and
   * the ids of any active decisions that were invalidated as a result. Thin
   * wrapper over `addDecision(input, { supersede: true })` that captures the
   * superseded ids for the caller's response. See `addDecision` for the
   * conflict heuristic.
   */
  addDecisionWithSupersession(input: DecisionInput): {
    decision: DecisionRow;
    superseded: number[];
  } {
    const superseded = this.findSupersedable(input);
    for (const id of superseded) {
      this.invalidateDecision(id);
    }
    // Already invalidated above — don't re-run the scan inside addDecision.
    const decision = this.addDecision(input);
    return { decision, superseded };
  }

  /**
   * Find active decisions that the given input would supersede (same
   * state key). Returns their ids. Pure read — does NOT invalidate. The
   * canonicalised `file_path` mirrors `addDecision` so absolute-vs-relative
   * inputs collide on the same stored rows.
   */
  private findSupersedable(input: DecisionInput): number[] {
    if (!input.project_root) return [];
    const symbolId = input.symbol_id ?? null;
    const canonFilePath = input.project_root
      ? (relativizeUnderRoot(input.file_path, input.project_root) ?? null)
      : (input.file_path ?? null);
    // No anchor → no state key → never supersedes.
    if (!symbolId && !canonFilePath) return [];

    const conditions: string[] = ['project_root = ?', 'type = ?', 'valid_until IS NULL'];
    const params: unknown[] = [input.project_root, input.type];
    if (symbolId) {
      // Symbol-anchored state key: match the exact symbol. File-only rows
      // (symbol_id IS NULL) must NOT collide with a symbol-anchored insert.
      conditions.push('symbol_id = ?');
      params.push(symbolId);
    } else {
      // File-anchored state key: only rows that are ALSO file-only (no
      // symbol) on the same file. Keeps the heuristic conservative.
      conditions.push('symbol_id IS NULL');
      conditions.push('file_path = ?');
      params.push(canonFilePath);
    }
    const rows = this.db
      .prepare(`SELECT id FROM decisions WHERE ${conditions.join(' AND ')}`)
      .all(...params) as Array<{ id: number }>;
    return rows.map((r) => r.id);
  }

  /** Invalidate every active decision sharing the input's state key. */
  private supersedeConflicting(input: DecisionInput): number[] {
    const ids = this.findSupersedable(input);
    for (const id of ids) {
      this.invalidateDecision(id);
    }
    return ids;
  }

  getDecision(id: number): DecisionRow | undefined {
    return this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as
      | DecisionRow
      | undefined;
  }

  /**
   * Memoir-style review queue actions: stamp a decision as approved or
   * rejected (or back to pending). Returns true when a row was actually
   * updated. Backing for the `approve_decision` / `reject_decision` MCP
   * tools and the `/api/projects/decisions/:id/review` HTTP endpoint.
   */
  setReviewStatus(
    id: number,
    status: 'pending' | 'approved' | 'rejected',
    opts: { reviewer?: string | null } = {},
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE decisions SET review_status = ?, updated_at = strftime('%s','now')*1000 WHERE id = ?`,
      )
      .run(status, id);
    if (info.changes > 0 && (status === 'approved' || status === 'rejected')) {
      // P2.5 — best-effort review-event log for confidence-weight tuning.
      // Wrapped in try/catch: a failed insert must NEVER fail the status
      // update itself.
      try {
        const decision = this.getDecision(id);
        if (decision) this.insertReviewEvent(decision, status, opts.reviewer ?? null);
      } catch (err) {
        logger.debug?.(
          { err: (err as Error).message, decisionId: id },
          'decision review-log write failed (non-fatal)',
        );
      }
    }
    return info.changes > 0;
  }

  /**
   * Insert one row into decision_reviews for the given decision. Recomputes
   * confidence on the fly so the review log always carries the score the
   * scorer would assign right now — which is what the tuner needs to compare
   * against the human label.
   */
  private insertReviewEvent(
    decision: DecisionRow,
    status: 'approved' | 'rejected',
    reviewer: string | null,
  ): void {
    const action = status === 'approved' ? 'approve' : 'reject';
    const signals = extractSignalsForReview(decision);
    const confidence = computeConfidence({
      title: decision.title,
      content: decision.content,
      type: decision.type,
      symbol_id: decision.symbol_id ?? undefined,
      file_path: decision.file_path ?? undefined,
      tags: parseTagsJson(decision.tags),
      service_name: decision.service_name ?? undefined,
    });
    const reviewedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO decision_reviews
           (decision_id, action, signals_at_decision, confidence_at_decision, reviewed_at, reviewer)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(decision.id, action, JSON.stringify(signals), confidence, reviewedAt, reviewer);
  }

  /**
   * Stream review events (approve/reject toggles) for the weight-tuner. When
   * `projectRoot` is set, results are filtered to reviews whose underlying
   * decision belongs to that project. Returns rows with signals already
   * parsed back into a structured object.
   */
  listReviewEvents(opts: { project_root?: string; limit?: number } = {}): Array<{
    id: number;
    decision_id: number;
    action: 'approve' | 'reject';
    signals: {
      has_code_ref: boolean;
      content_length: number;
      tag_count: number;
      type: string;
      has_service: boolean;
    };
    confidence_at_decision: number;
    reviewed_at: string;
    reviewer: string | null;
  }> {
    const limit = opts.limit ?? 10000;
    const where = opts.project_root ? 'WHERE d.project_root = ?' : '';
    const params: unknown[] = opts.project_root ? [opts.project_root] : [];
    const sql = `
      SELECT r.id, r.decision_id, r.action, r.signals_at_decision,
             r.confidence_at_decision, r.reviewed_at, r.reviewer
      FROM decision_reviews r
      JOIN decisions d ON d.id = r.decision_id
      ${where}
      ORDER BY r.id ASC
      LIMIT ?
    `;
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      decision_id: number;
      action: 'approve' | 'reject';
      signals_at_decision: string;
      confidence_at_decision: number;
      reviewed_at: string;
      reviewer: string | null;
    }>;
    return rows.map((r) => {
      let signals: {
        has_code_ref: boolean;
        content_length: number;
        tag_count: number;
        type: string;
        has_service: boolean;
      };
      try {
        signals = JSON.parse(r.signals_at_decision);
      } catch {
        // Corrupt row — skip safely by zeroing signals. The tuner ignores
        // events whose signals don't deserialize cleanly via its own checks.
        signals = {
          has_code_ref: false,
          content_length: 0,
          tag_count: 0,
          type: '',
          has_service: false,
        };
      }
      return {
        id: r.id,
        decision_id: r.decision_id,
        action: r.action,
        signals,
        confidence_at_decision: r.confidence_at_decision,
        reviewed_at: r.reviewed_at,
        reviewer: r.reviewer,
      };
    });
  }

  /**
   * Count of rows currently in the review queue (`review_status = 'pending'`).
   * Used by the Memory Explorer Review tab badge and the wake-up surface.
   */
  countPendingReviews(projectRoot?: string): number {
    if (projectRoot) {
      return (
        this.db
          .prepare(
            "SELECT COUNT(*) as c FROM decisions WHERE review_status = 'pending' AND project_root = ? AND valid_until IS NULL",
          )
          .get(projectRoot) as { c: number }
      ).c;
    }
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) as c FROM decisions WHERE review_status = 'pending' AND valid_until IS NULL",
        )
        .get() as { c: number }
    ).c;
  }

  invalidateDecision(id: number, validUntil?: string): boolean {
    const until = validUntil ?? new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE decisions SET valid_until = ?, updated_at = strftime('%s','now')*1000
         WHERE id = ? AND valid_until IS NULL`,
      )
      .run(until, id);
    if (info.changes > 0) {
      const row = this.getDecision(id);
      this.auditEmit('invalidate', id, {
        title: row?.title,
        type: row?.type,
      });
    }
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
    // git_branch filter:
    //   undefined  → no filter (back-compat)
    //   'all'      → no filter
    //   null       → only branch-agnostic rows
    //   <string>   → that branch + branch-agnostic rows
    if (query.git_branch !== undefined && query.git_branch !== 'all') {
      if (query.git_branch === null) {
        conditions.push('d.git_branch IS NULL');
      } else {
        conditions.push('(d.git_branch = ? OR d.git_branch IS NULL)');
        params.push(query.git_branch);
      }
    }
    if (!query.include_invalidated) {
      if (query.as_of) {
        conditions.push('d.valid_from <= ? AND (d.valid_until IS NULL OR d.valid_until > ?)');
        params.push(query.as_of, query.as_of);
      } else {
        conditions.push('d.valid_until IS NULL');
      }
    }

    // Memoir-style review filter:
    //   review_status given       → restrict to that exact status
    //   include_pending = true    → return NULL + 'approved' + 'pending'
    //   neither                   → default: NULL + 'approved' (hide pending/rejected)
    if (query.review_status) {
      conditions.push('d.review_status = ?');
      params.push(query.review_status);
    } else if (query.include_pending) {
      conditions.push("(d.review_status IS NULL OR d.review_status IN ('approved','pending'))");
    } else {
      conditions.push("(d.review_status IS NULL OR d.review_status = 'approved')");
    }

    // FTS search — join with FTS table
    if (query.search) {
      conditions.push('d.id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?)');
      params.push(query.search);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const orderBy = query.order_by ?? 'recency';

    // Heat ordering is computed in JS because SQLite has no portable exp().
    // Fetch up to limit*3 rows (capped at 500) under the same WHERE,
    // compute heat per row, sort, then slice. Keeps the deterministic
    // pre-filter cheap and avoids loading the whole table.
    if (orderBy === 'heat') {
      const HEAT_FETCH_CAP = 500;
      const fetchCount = Math.min(Math.max(limit * 3, limit), HEAT_FETCH_CAP);
      const sql = `SELECT d.* FROM decisions d ${where} ORDER BY d.valid_from DESC LIMIT ?`;
      params.push(fetchCount);
      const rows = this.db.prepare(sql).all(...params) as DecisionRow[];
      const now = new Date();
      const heatParams = {
        now,
        halfLifeDays: query.heat_half_life_days,
        freshnessDays: query.heat_freshness_days,
      };
      // Stable sort: heat DESC, tie-break by valid_from DESC (newer first).
      // Search-time temporal decay (Task 11) multiplies the base heat by a
      // recency boost / staleness dampening factor — reranking only, never
      // mutating stored state. Neutral (1.0×) for mid-age rows.
      const scored = rows.map((r) => ({
        row: r,
        heat:
          computeHeat(
            {
              hit_count: r.hit_count ?? 0,
              last_hit_at: r.last_hit_at,
              created_at: r.created_at,
            },
            heatParams,
          ) *
          heatDecayMultiplier({ created_at: r.created_at, last_hit_at: r.last_hit_at }, { now }),
      }));
      scored.sort((a, b) => {
        if (b.heat !== a.heat) return b.heat - a.heat;
        return a.row.valid_from < b.row.valid_from
          ? 1
          : a.row.valid_from > b.row.valid_from
            ? -1
            : 0;
      });
      return scored.slice(offset, offset + limit).map((s) => s.row);
    }

    const orderClause =
      orderBy === 'created_at' ? 'ORDER BY d.created_at DESC' : 'ORDER BY d.valid_from DESC';
    const sql = `SELECT d.* FROM decisions d ${where} ${orderClause} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as DecisionRow[];
  }

  // ── HEAT / TIME-DECAY ─────────────────────────────────────────────────
  //
  // Heat tracks how often + how recently each decision is recalled by a
  // read-side surface (query_decisions, get_wake_up, get_decision_timeline).
  // `recordHits` is the write path; `getHeat`/`getHottest` are the read path.

  /**
   * Record one or more recall hits. Increments `hit_count` and stamps
   * `last_hit_at` to now() for every existing id in a single transaction.
   * Missing ids are silently ignored — callers don't care, and the
   * UPDATE's `WHERE id = ?` natively no-ops. Safe to call fire-and-forget.
   */
  recordHits(decisionIds: number[]): void {
    if (decisionIds.length === 0) return;
    const nowIso = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE decisions
         SET hit_count = hit_count + 1,
             last_hit_at = ?
       WHERE id = ?`,
    );
    const tx = this.db.transaction((ids: number[]) => {
      for (const id of ids) stmt.run(nowIso, id);
    });
    tx(decisionIds);
  }

  /**
   * Compute the heat score for a single decision. Returns 0 when the
   * decision does not exist, so callers can treat this as a safe accessor.
   */
  getHeat(id: number, params?: { halfLifeDays?: number; freshnessDays?: number }): number {
    const row = this.getDecision(id);
    if (!row) return 0;
    return computeHeat(
      {
        hit_count: row.hit_count ?? 0,
        last_hit_at: row.last_hit_at,
        created_at: row.created_at,
      },
      {
        now: new Date(),
        halfLifeDays: params?.halfLifeDays,
        freshnessDays: params?.freshnessDays,
      },
    );
  }

  /**
   * Return the hottest N decisions (highest heat first). Filters mirror the
   * common query knobs: project_root, service_name, git_branch. Only active
   * (non-invalidated) and visible (NULL/approved) rows are considered.
   */
  getHottest(opts: {
    project_root?: string;
    service_name?: string;
    git_branch?: string;
    limit?: number;
    halfLifeDays?: number;
    freshnessDays?: number;
  }): DecisionRow[] {
    const limit = opts.limit ?? 10;
    const conditions: string[] = ['valid_until IS NULL'];
    const params: unknown[] = [];

    if (opts.project_root) {
      conditions.push('project_root = ?');
      params.push(opts.project_root);
    }
    if (opts.service_name) {
      conditions.push('service_name = ?');
      params.push(opts.service_name);
    }
    if (opts.git_branch !== undefined) {
      conditions.push('(git_branch = ? OR git_branch IS NULL)');
      params.push(opts.git_branch);
    }
    conditions.push("(review_status IS NULL OR review_status = 'approved')");

    const HEAT_FETCH_CAP = 500;
    const fetchCount = Math.min(Math.max(limit * 3, limit), HEAT_FETCH_CAP);
    const sql = `SELECT * FROM decisions WHERE ${conditions.join(' AND ')} ORDER BY valid_from DESC LIMIT ?`;
    params.push(fetchCount);
    const rows = this.db.prepare(sql).all(...params) as DecisionRow[];
    const now = new Date();
    const scored = rows.map((r) => ({
      row: r,
      heat: computeHeat(
        {
          hit_count: r.hit_count ?? 0,
          last_hit_at: r.last_hit_at,
          created_at: r.created_at,
        },
        {
          now,
          halfLifeDays: opts.halfLifeDays,
          freshnessDays: opts.freshnessDays,
        },
      ),
    }));
    scored.sort((a, b) => b.heat - a.heat);
    return scored.slice(0, limit).map((s) => s.row);
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

    const total = (
      this.db.prepare(`SELECT COUNT(*) as c FROM decisions${filter}`).get(...params) as {
        c: number;
      }
    ).c;
    const active = (
      this.db
        .prepare(
          `SELECT COUNT(*) as c FROM decisions${filter}${filter ? ' AND' : ' WHERE'} valid_until IS NULL`,
        )
        .get(...params) as { c: number }
    ).c;

    const typeRows = this.db
      .prepare(`SELECT type, COUNT(*) as c FROM decisions${filter} GROUP BY type`)
      .all(...params) as Array<{ type: string; c: number }>;
    const by_type: Record<string, number> = {};
    for (const r of typeRows) by_type[r.type] = r.c;

    const sourceRows = this.db
      .prepare(`SELECT source, COUNT(*) as c FROM decisions${filter} GROUP BY source`)
      .all(...params) as Array<{ source: string; c: number }>;
    const by_source: Record<string, number> = {};
    for (const r of sourceRows) by_source[r.source] = r.c;

    return { total, active, invalidated: total - active, by_type, by_source };
  }

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

  // ── CODE-AWARE QUERIES ────────────────────────────────────────────

  /** Get all decisions linked to a specific symbol */
  getDecisionsForSymbol(symbolId: string, activeOnly = true): DecisionRow[] {
    const filter = activeOnly ? ' AND valid_until IS NULL' : '';
    return this.db
      .prepare(`SELECT * FROM decisions WHERE symbol_id = ?${filter} ORDER BY valid_from DESC`)
      .all(symbolId) as DecisionRow[];
  }

  /** Get all decisions linked to a specific file */
  getDecisionsForFile(filePath: string, activeOnly = true): DecisionRow[] {
    const filter = activeOnly ? ' AND valid_until IS NULL' : '';
    return this.db
      .prepare(`SELECT * FROM decisions WHERE file_path = ?${filter} ORDER BY valid_from DESC`)
      .all(filePath) as DecisionRow[];
  }

  /** Get decisions linked to any file matching a pattern (e.g., 'src/auth/%') */
  getDecisionsForPath(pathPattern: string, activeOnly = true): DecisionRow[] {
    const filter = activeOnly ? ' AND valid_until IS NULL' : '';
    return this.db
      .prepare(`SELECT * FROM decisions WHERE file_path LIKE ?${filter} ORDER BY valid_from DESC`)
      .all(pathPattern) as DecisionRow[];
  }

  /** Get all decisions for a specific subproject within a project */
  getDecisionsForService(
    serviceName: string,
    projectRoot?: string,
    activeOnly = true,
  ): DecisionRow[] {
    const filter = activeOnly ? ' AND valid_until IS NULL' : '';
    if (projectRoot) {
      return this.db
        .prepare(
          `SELECT * FROM decisions WHERE service_name = ? AND project_root = ?${filter} ORDER BY valid_from DESC`,
        )
        .all(serviceName, projectRoot) as DecisionRow[];
    }
    return this.db
      .prepare(`SELECT * FROM decisions WHERE service_name = ?${filter} ORDER BY valid_from DESC`)
      .all(serviceName) as DecisionRow[];
  }

  /** Get all distinct service names in a project */
  getServiceNames(projectRoot: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT DISTINCT service_name FROM decisions WHERE project_root = ? AND service_name IS NOT NULL',
      )
      .all(projectRoot) as Array<{ service_name: string }>;
    return rows.map((r) => r.service_name);
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

  // ── DECISION CLUSTERS (P1.1) ─────────────────────────────────────────
  //
  // Clusters are an L2 thematic overlay produced by the LLM clusterer in
  // `src/memory/decision-clusterer.ts`. Each cluster carries a noun-phrase
  // title + summary + tag list + member decision ids. Cluster ids are
  // stable across `build_decision_clusters` re-runs via title similarity
  // (the tool handler merges freshly-computed clusters into existing rows
  // when their titles agree ≥0.8).

  /**
   * Insert a cluster + its membership rows in a single transaction.
   * `decision_count` is set from the input `decision_ids.length`.
   * Returns the inserted ClusterRow.
   */
  createCluster(input: ClusterInput): ClusterRow {
    return this.clusterOps.createCluster(input);
  }

  /**
   * Update an existing cluster's title/summary/tags/primary_type and
   * replace its membership list. Used when `build_decision_clusters`
   * merges a freshly-computed cluster into an existing row.
   */
  updateCluster(
    id: number,
    input: {
      title?: string;
      summary?: string;
      tags?: string[];
      primary_type?: DecisionType | null;
      decision_ids?: number[];
    },
  ): ClusterRow | undefined {
    return this.clusterOps.updateCluster(id, input);
  }

  /** Single-cluster lookup by id. */
  getCluster(id: number): ClusterRow | undefined {
    return this.clusterOps.getCluster(id);
  }

  /**
   * List clusters with optional project/service/search filters.
   * Default ordering is by `decision_count DESC` (largest first) so the
   * wake-up "topics" surface lands the biggest topics on top.
   */
  listClusters(query: ClusterQuery = {}): ClusterRow[] {
    return this.clusterOps.listClusters(query);
  }

  /**
   * Get the member decisions of a cluster. Respects active-only by default
   * (matches `query_decisions` defaults). `include_invalidated` returns
   * the full historical membership.
   */
  getClusterDecisions(
    clusterId: number,
    opts: { limit?: number; include_invalidated?: boolean } = {},
  ): DecisionRow[] {
    return this.clusterOps.getClusterDecisions(clusterId, opts);
  }

  /**
   * Find all clusters a decision belongs to. Used by surfaces that want
   * to annotate a decision with its parent topic(s).
   */
  findClustersForDecision(decisionId: number): ClusterRow[] {
    return this.clusterOps.findClustersForDecision(decisionId);
  }

  /**
   * Delete a cluster. The `ON DELETE CASCADE` on
   * `decision_cluster_members.cluster_id` drops the membership rows
   * automatically. Returns true when a row was removed.
   */
  deleteCluster(id: number): boolean {
    return this.clusterOps.deleteCluster(id);
  }

  /**
   * Drop every cluster (and cascade-drop their membership rows) for a
   * scope. Used by `build_decision_clusters` when `force=true` to start
   * from a clean slate. Returns the number of cluster rows removed.
   */
  deleteClustersForScope(opts: { project_root?: string; service_name?: string }): number {
    return this.clusterOps.deleteClustersForScope(opts);
  }

  /** Count clusters in a scope (used by tests + stats). */
  countClusters(opts: { project_root?: string; service_name?: string } = {}): number {
    return this.clusterOps.countClusters(opts);
  }

  // ── PROJECT MEMOS (L3 orientation digest) ───────────────────────────
  //
  // Project memos are LLM-synthesised Markdown orientation digests over the
  // decision store. Each regeneration inserts a NEW row (version+1) rather
  // than overwriting — old memos are retained for history. Read paths only
  // ever surface the LATEST row per (project_root, service_name).

  /**
   * Insert a new project memo row. Computes `version` as `prev.version + 1`
   * when an earlier memo exists for the same (project_root, service_name)
   * scope, otherwise 1. Returns the new {id, version}.
   */
  saveProjectMemo(input: {
    project_root: string;
    service_name?: string;
    memo_md: string;
    model?: string;
    last_decision_id?: number;
    decisions_at_generation: number;
    clusters_at_generation: number;
    estimated_tokens: number;
  }): { id: number; version: number } {
    return this.memoOps.saveProjectMemo(input);
  }

  /**
   * Return the most-recent memo for a (project_root, service_name) scope, or
   * undefined when no memo has been generated. `service_name` semantics
   * mirror the decisions/clusters surfaces — omit for the project-wide memo,
   * supply a name for the per-service one.
   */
  getLatestProjectMemo(opts: {
    project_root: string;
    service_name?: string;
  }): ProjectMemoRow | undefined {
    return this.memoOps.getLatestProjectMemo(opts);
  }

  /**
   * List historical memos in a scope (most-recent first). Default limit 10.
   * Used by `get_project_memo` when `include_history=true`.
   */
  listProjectMemos(opts: {
    project_root: string;
    service_name?: string;
    limit?: number;
  }): ProjectMemoRow[] {
    return this.memoOps.listProjectMemos(opts);
  }

  /**
   * Count of decisions whose id > the latest memo's `last_decision_id`,
   * scoped to the same project (+ optional service). Drives the auto-
   * regen threshold in `regenerate_project_memo`. When no prior memo
   * exists, returns the total active decision count in scope.
   */
  countDecisionsSinceLastMemo(opts: { project_root: string; service_name?: string }): number {
    return this.memoOps.countDecisionsSinceLastMemo(opts);
  }

  // ── SCHEDULER STATE (durable per-project cooldown bookkeeping) ────
  //
  // The background MemoryScheduler keeps lastMineAt / lastClusterAt /
  // lastMemoAt / lastTuneAt / consecutiveFailures in memory. Persisting
  // them lets a daemon restart skip stages that already ran on the
  // previous boot — avoiding a thundering herd of LLM-backed mine /
  // cluster / memo / tune calls on the first tick.

  /** Fetch the persisted scheduler state for a project, or undefined. */
  getSchedulerState(projectRoot: string): SchedulerStateRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM scheduler_state WHERE project_root = ?')
      .get(projectRoot) as SchedulerStateRow | undefined;
    return row ?? undefined;
  }

  /**
   * Upsert per-project scheduler state. Merge semantics:
   *   - `undefined` fields PRESERVE the existing column value (no overwrite).
   *   - `null` fields EXPLICITLY clear the column.
   *   - `consecutive_failures` defaults to existing value on update,
   *     or 0 on insert.
   *   - `updated_at` is always stamped to ISO `now()`.
   *
   * Runs inside a transaction so the read-then-write merge is atomic.
   */
  upsertSchedulerState(input: {
    project_root: string;
    last_mine_at?: number | null;
    last_cluster_at?: number | null;
    last_memo_at?: number | null;
    last_tune_at?: number | null;
    last_tune_event_count?: number | null;
    consecutive_failures?: number;
  }): void {
    const nowIso = new Date().toISOString();
    const selectStmt = this.db.prepare('SELECT * FROM scheduler_state WHERE project_root = ?');
    const insertStmt = this.db.prepare(
      `INSERT INTO scheduler_state
         (project_root, last_mine_at, last_cluster_at, last_memo_at,
          last_tune_at, last_tune_event_count, consecutive_failures, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateStmt = this.db.prepare(
      `UPDATE scheduler_state
         SET last_mine_at = ?,
             last_cluster_at = ?,
             last_memo_at = ?,
             last_tune_at = ?,
             last_tune_event_count = ?,
             consecutive_failures = ?,
             updated_at = ?
       WHERE project_root = ?`,
    );
    const tx = this.db.transaction(() => {
      const existing = selectStmt.get(input.project_root) as SchedulerStateRow | undefined;
      const pick = <T>(next: T | null | undefined, prev: T | null | undefined): T | null => {
        if (next === undefined) return (prev ?? null) as T | null;
        return next as T | null;
      };
      const lastMine = pick(input.last_mine_at, existing?.last_mine_at);
      const lastCluster = pick(input.last_cluster_at, existing?.last_cluster_at);
      const lastMemo = pick(input.last_memo_at, existing?.last_memo_at);
      const lastTune = pick(input.last_tune_at, existing?.last_tune_at);
      const lastTuneEv = pick(input.last_tune_event_count, existing?.last_tune_event_count);
      const failures =
        input.consecutive_failures !== undefined
          ? input.consecutive_failures
          : (existing?.consecutive_failures ?? 0);
      if (existing) {
        updateStmt.run(
          lastMine,
          lastCluster,
          lastMemo,
          lastTune,
          lastTuneEv,
          failures,
          nowIso,
          input.project_root,
        );
      } else {
        insertStmt.run(
          input.project_root,
          lastMine,
          lastCluster,
          lastMemo,
          lastTune,
          lastTuneEv,
          failures,
          nowIso,
        );
      }
    });
    tx();
  }

  // ── SEMANTIC DEDUP / CONSOLIDATION (P2.2) ─────────────────────────
  //
  // Two surfaces backing the `consolidate_decisions` MCP tool:
  //   - `findSimilarDecisions` — top-K candidates for a subject via FTS5
  //     full-text match + title trigram similarity.
  //   - `applyConsolidationVerdict` — atomic application of one LLM
  //     verdict (merge / replace / invalidate / keep_separate).

  /**
   * Return up to `topK` candidates similar to the given subject, sorted by
   * title trigram similarity (descending). Combines:
   *   - FTS5 match on the subject's title words (OR-joined; quoted for
   *     safety against FTS operators in titles)
   *   - same-`type` filter when `same_type_only`
   *   - trigram Jaccard floor (`min_title_similarity`)
   *   - excludes the subject itself, optionally invalidated rows
   *
   * Returns [] when the subject has no FTS-extractable title words and
   * no candidate set can be produced cheaply.
   */
  findSimilarDecisions(opts: {
    subject_id: number;
    topK?: number;
    min_title_similarity?: number;
    same_type_only?: boolean;
    project_root?: string;
    active_only?: boolean;
  }): DecisionRow[] {
    const subject = this.getDecision(opts.subject_id);
    if (!subject) return [];

    const topK = Math.max(1, Math.min(opts.topK ?? 5, 50));
    const minSim = Math.max(0, Math.min(opts.min_title_similarity ?? 0.4, 1));
    const sameTypeOnly = opts.same_type_only ?? false;
    const activeOnly = opts.active_only ?? true;
    // Default project scope = the subject's own project. Pass `''` to mean
    // "any project" (rare; mostly for cross-project audits).
    const projectScope = opts.project_root !== undefined ? opts.project_root : subject.project_root;

    // Build the candidate pool. We branch on whether we can produce a
    // useful FTS query — short / punctuation-only titles fall through to
    // a project-wide scan capped at 500 rows.
    const ftsWords = extractFtsWords(subject.title);
    const conditions: string[] = ['d.id <> ?'];
    const params: unknown[] = [subject.id];

    if (projectScope) {
      conditions.push('d.project_root = ?');
      params.push(projectScope);
    }
    if (activeOnly) {
      conditions.push('d.valid_until IS NULL');
    }
    if (sameTypeOnly) {
      conditions.push('d.type = ?');
      params.push(subject.type);
    }

    let pool: DecisionRow[];
    if (ftsWords.length > 0) {
      const ftsQuery = ftsWords.map((w) => `"${w}"`).join(' OR ');
      conditions.push('d.id IN (SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH ?)');
      params.push(ftsQuery);
      const sql = `SELECT d.* FROM decisions d WHERE ${conditions.join(' AND ')} LIMIT 200`;
      pool = this.db.prepare(sql).all(...params) as DecisionRow[];
    } else {
      const sql = `SELECT d.* FROM decisions d WHERE ${conditions.join(' AND ')} ORDER BY d.valid_from DESC LIMIT 500`;
      pool = this.db.prepare(sql).all(...params) as DecisionRow[];
    }

    // Score by trigram similarity to the subject's title.
    const scored = pool
      .map((row) => ({ row, sim: titleSimilarity(subject.title, row.title) }))
      .filter((s) => s.sim >= minSim);
    scored.sort((a, b) => b.sim - a.sim);

    return scored.slice(0, topK).map((s) => s.row);
  }

  /**
   * Atomically apply one consolidation verdict. Returns whether any write
   * happened and which row ids were touched (useful for the MCP response
   * envelope and audit logs).
   *
   * Verdict semantics:
   *   - `keep_separate`        → no-op, applied=false
   *   - `merge_into_existing`  → update existing.content (concat unless
   *     `merged_content` is provided), union tags, invalidate subject
   *   - `replace_existing`     → invalidate existing, subject untouched
   *   - `invalidate_existing`  → invalidate existing only
   *
   * Runs in a single transaction so a mid-flight failure rolls back
   * cleanly. Returns `applied:false` when either row is missing or already
   * invalidated (defensive — the LLM may pick a row that was just
   * invalidated by a prior verdict in the same batch).
   */
  applyConsolidationVerdict(opts: {
    subject_id: number;
    verdict: ConsolidationVerdict;
    /** Optional: caller-supplied merged content. If absent, plain concat. */
    merged_content?: string;
  }): { applied: boolean; affected_ids: number[] } {
    if (opts.verdict.kind === 'keep_separate') {
      return { applied: false, affected_ids: [] };
    }

    const tx = this.db.transaction(() => {
      const subject = this.getDecision(opts.subject_id);
      if (!subject) return { applied: false, affected_ids: [] as number[] };

      const existingId =
        opts.verdict.kind === 'merge_into_existing' ||
        opts.verdict.kind === 'replace_existing' ||
        opts.verdict.kind === 'invalidate_existing'
          ? opts.verdict.existing_id
          : null;

      const existing = existingId !== null ? this.getDecision(existingId) : null;
      if (!existing) return { applied: false, affected_ids: [] as number[] };

      // Refuse to act on a row whose validity window has already closed.
      // A prior verdict may have invalidated it earlier in this batch.
      if (existing.valid_until !== null) {
        return { applied: false, affected_ids: [] as number[] };
      }

      switch (opts.verdict.kind) {
        case 'merge_into_existing': {
          if (subject.valid_until !== null) {
            // Subject already invalidated — nothing left to merge.
            return { applied: false, affected_ids: [] as number[] };
          }
          const mergedContent =
            opts.merged_content ?? mergeContents(existing.content, subject.content);
          const mergedTagsArr = mergeTags(
            parseTagsJson(existing.tags),
            parseTagsJson(subject.tags),
          );
          this.updateDecision(existing.id, {
            content: mergedContent,
            tags: mergedTagsArr,
          });
          this.invalidateDecision(subject.id);
          return { applied: true, affected_ids: [existing.id, subject.id] };
        }
        case 'replace_existing': {
          this.invalidateDecision(existing.id);
          return { applied: true, affected_ids: [existing.id] };
        }
        case 'invalidate_existing': {
          this.invalidateDecision(existing.id);
          return { applied: true, affected_ids: [existing.id] };
        }
        default:
          return { applied: false, affected_ids: [] as number[] };
      }
    });

    return tx();
  }
}

/**
 * Extract FTS5-safe word tokens from a title. Strips punctuation, filters
 * very short / numeric-only tokens, and dedups while preserving order.
 * Returns at most 8 tokens — FTS5 OR-queries with 20+ terms get costly.
 */
function extractFtsWords(title: string): string[] {
  if (!title) return [];
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

/** Local helper mirroring the consolidator's parseTags. Avoids a circular
 *  dep since the store is the lower-level module. */
function parseTagsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string').slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * P2.5 — Pure helper that projects a DecisionRow to the signal payload
 * stored in decision_reviews.signals_at_decision. Exported so the tuner
 * and tests can mirror the projection without importing the store class.
 */
export function extractSignalsForReview(d: DecisionRow): {
  has_code_ref: boolean;
  content_length: number;
  tag_count: number;
  type: string;
  has_service: boolean;
} {
  const tags = parseTagsJson(d.tags);
  return {
    has_code_ref: !!(d.symbol_id || d.file_path),
    content_length: (d.content ?? '').length,
    tag_count: tags.length,
    type: d.type,
    has_service: !!d.service_name,
  };
}
