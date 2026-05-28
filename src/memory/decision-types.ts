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
