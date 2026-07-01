/**
 * Memoir-style review-queue persistence — extracted from `DecisionStore`
 * (Task: god-class decomposition). Owns the review surface:
 *
 *   - `setReviewStatus`     — approve / reject / re-pend a decision, and
 *     best-effort log a review event for confidence-weight tuning.
 *   - `insertReviewEvent`   — append one row to `decision_reviews`,
 *     recomputing confidence on the fly against the current scorer.
 *   - `listReviewEvents`    — stream review events for the weight-tuner.
 *   - `countPendingReviews` — review-queue badge count.
 *
 * `setReviewStatus` needs a single-row lookup, injected via a `getDecision`
 * callback so this module never imports the store (no import cycle).
 * `extractSignalsForReview` lives here (a pure projection) and is re-exported
 * from `decision-store.ts` for back-compat with the tuner + tests.
 *
 * `DecisionStore` holds one `ReviewOperations` instance and delegates its
 * public review methods to it verbatim — the public API and behavior are
 * unchanged, only the implementation moved.
 */

import type Database from 'better-sqlite3';
import { logger } from '../logger.js';
import { computeConfidence } from './decision-confidence.js';
import { parseTagsJson } from './decision-store-consolidation-ops.js';
import type { DecisionRow } from './decision-types.js';

/** The signal payload persisted in `decision_reviews.signals_at_decision`. */
export interface ReviewEventSignals {
  has_code_ref: boolean;
  content_length: number;
  tag_count: number;
  type: string;
  has_service: boolean;
}

/**
 * Pure helper that projects a DecisionRow to the signal payload stored in
 * `decision_reviews.signals_at_decision`. Exported so the tuner and tests can
 * mirror the projection without importing the store class.
 */
export function extractSignalsForReview(d: DecisionRow): ReviewEventSignals {
  const tags = parseTagsJson(d.tags);
  return {
    has_code_ref: !!(d.symbol_id || d.file_path),
    content_length: (d.content ?? '').length,
    tag_count: tags.length,
    type: d.type,
    has_service: !!d.service_name,
  };
}

/** The slice of `DecisionStore` that the review-path needs. Injected so this
 *  module never imports the store (which would close an import cycle). */
export interface ReviewHost {
  getDecision(id: number): DecisionRow | undefined;
}

export class ReviewOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly host: ReviewHost,
  ) {}

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
        const decision = this.host.getDecision(id);
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
    signals: ReviewEventSignals;
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
      let signals: ReviewEventSignals;
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
}
