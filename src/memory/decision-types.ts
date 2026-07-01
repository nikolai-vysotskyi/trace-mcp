/**
 * Decision types — shared shape definitions for the decision store and its
 * helper modules (clusterer, confidence scorer, consolidator, tuner).
 *
 * Extracted from `decision-store.ts` to break import cycles: the helpers
 * needed these types as inputs while the store needed the helpers as
 * functions, producing circular imports. Splitting the type surface lets
 * both sides import from a single leaf module instead.
 *
 * `decision-store.ts` re-exports these names for backwards compatibility,
 * so external callers keep importing from `./decision-store.js`.
 */

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
  /** Optional: subproject name within the project (e.g., 'auth-api', 'user-service') */
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
  /**
   * Git branch the decision was captured on. NULL = branch-agnostic
   * (captured outside a git repo, on detached HEAD, or pre-feature legacy data).
   */
  git_branch: string | null;
  /**
   * Memoir-style review status:
   *   - `null`       — auto-approved or legacy row (default; visible by default)
   *   - `'pending'`  — captured at borderline confidence; awaiting human review
   *   - `'approved'` — explicitly approved by a human (visible by default)
   *   - `'rejected'` — explicitly rejected by a human (hidden by default)
   */
  review_status: 'pending' | 'approved' | 'rejected' | null;
  created_at: string;
  /** Unix millisecond timestamp of the last write (insert, update, or invalidate). */
  updated_at: number | null;
  /**
   * Number of times this decision has been recalled by a read-side surface
   * (query_decisions, get_wake_up, get_decision_timeline). Drives the heat
   * term in `computeHeat`. Defaults to 0 for legacy rows.
   */
  hit_count: number;
  /**
   * ISO timestamp of the most recent recall hit, or null when the decision
   * has never been recalled. Combined with `hit_count` to compute time-decay
   * heat in `computeHeat`.
   */
  last_hit_at: string | null;
}

export interface DecisionInput {
  title: string;
  content: string;
  type: DecisionType;
  project_root: string;
  /** Subproject name within the project (e.g., 'auth-api') */
  service_name?: string;
  symbol_id?: string;
  file_path?: string;
  tags?: string[];
  valid_from?: string;
  session_id?: string;
  source?: 'manual' | 'mined' | 'auto';
  confidence?: number;
  /**
   * Git branch the decision was captured on. Omit / pass `null` for branch-agnostic
   * decisions (queryable from every branch). The capture path resolves this from
   * the project root automatically when omitted.
   */
  git_branch?: string | null;
  /**
   * Memoir-style review status. Omit (or pass `null`) for auto-approved /
   * legacy rows; pass `'pending'` when capture confidence is borderline so
   * the row goes into the human review queue.
   */
  review_status?: 'pending' | 'approved' | 'rejected' | null;
}

// ── QUERY / TIMELINE SHAPES ───────────────────────────────────────────

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

// ── DECISION CLUSTERS (P1.1) ──────────────────────────────────────────
//
// Cluster + memo row/query shapes live here (not in `decision-store.ts`) so
// the extracted persistence modules (`decision-store-cluster-ops.ts`,
// `decision-store-memo-ops.ts`) can import them without closing an import
// cycle back through the store. `decision-store.ts` re-exports them for API
// back-compat.

export interface ClusterRow {
  id: number;
  project_root: string;
  service_name: string | null;
  title: string;
  summary: string;
  /** JSON array of tag strings (or null). */
  tags: string | null;
  primary_type: DecisionType | null;
  decision_count: number;
  created_at: string;
  /** Unix millisecond timestamp of the last write. */
  updated_at: number;
}

export interface ClusterInput {
  project_root: string;
  service_name?: string | null;
  title: string;
  summary: string;
  tags?: string[];
  primary_type?: DecisionType | null;
  decision_ids: number[];
}

export interface ClusterQuery {
  project_root?: string;
  service_name?: string;
  /** Full-text search across title + summary + tags (FTS5 with porter stemming). */
  search?: string;
  /**
   * Sort order.
   *   - 'decision_count' (default) — largest clusters first
   *   - 'updated_at'              — most-recently-rebuilt first
   *   - 'title'                   — alphabetical
   */
  order_by?: 'decision_count' | 'updated_at' | 'title';
  limit?: number;
  offset?: number;
}

// ── PROJECT MEMOS (L3 orientation digest) ─────────────────────────────
//
// A project memo is a 250-400 word LLM-synthesised Markdown document that
// captures the project's architectural personality: dominant tech choices,
// conventions, in-flight work, named subsystems. It's the L3 narrative
// overlay over L1 (raw decisions) and L2 (clusters).
//
// Only the LATEST row per (project_root, service_name) is read by surfaces.
// Old rows are retained for history (regenerate inserts a new row with
// version+1 rather than overwriting).

export interface ProjectMemoRow {
  id: number;
  project_root: string;
  /** Null for project-wide memos; subproject name for per-service memos. */
  service_name: string | null;
  memo_md: string;
  version: number;
  /** Identifier of the LLM that produced this memo (provider + model hint). */
  model: string | null;
  created_at: string;
  updated_at: string;
  /** Highest decision.id at the time of generation — used to compute drift. */
  last_decision_id: number | null;
  /** Decision count in scope when this memo was generated. */
  decisions_at_generation: number;
  /** Cluster count in scope when this memo was generated. */
  clusters_at_generation: number;
  /** Rough chars/4 token estimate of memo_md at write time. */
  estimated_tokens: number;
}

// ── SESSION CHUNKS (cross-session conversation search) ────────────────

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
