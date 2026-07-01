/**
 * Project memo persistence — extracted from `DecisionStore` (Task: god-class
 * decomposition). Owns the `project_memos` table: insert-with-versioning,
 * latest-row lookup, history listing, and the "decisions since last memo"
 * drift counter used to drive auto-regeneration.
 *
 * `DecisionStore` holds one `MemoOperations` instance and delegates its
 * public `saveProjectMemo` / `getLatestProjectMemo` / `listProjectMemos` /
 * `countDecisionsSinceLastMemo` methods to it verbatim — the public API and
 * behavior are unchanged, only the implementation moved.
 */

import type Database from 'better-sqlite3';
import type { ProjectMemoRow } from './decision-types.js';

export class MemoOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly memoHistoryLimit: number,
  ) {}

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
    const nowIso = new Date().toISOString();
    const service = input.service_name ?? null;
    const prev = this.getLatestProjectMemo({
      project_root: input.project_root,
      service_name: input.service_name,
    });
    const version = prev ? prev.version + 1 : 1;
    const insertStmt = this.db.prepare(
      `INSERT INTO project_memos
         (project_root, service_name, memo_md, version, model,
          created_at, updated_at, last_decision_id,
          decisions_at_generation, clusters_at_generation, estimated_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Retention prune: keep at most `memoHistoryLimit` rows for this scope
    // (project_root, COALESCE(service_name,'')). Runs inside the same
    // transaction as the INSERT so the table never breaches the bound
    // visibly. Per-scope only — other scopes are untouched.
    const pruneStmt = this.db.prepare(
      `DELETE FROM project_memos
         WHERE id NOT IN (
           SELECT id FROM project_memos
            WHERE project_root = ?
              AND COALESCE(service_name,'') = COALESCE(?,'')
            ORDER BY version DESC, id DESC
            LIMIT ?
         )
         AND project_root = ?
         AND COALESCE(service_name,'') = COALESCE(?,'')`,
    );
    const tx = this.db.transaction(() => {
      const info = insertStmt.run(
        input.project_root,
        service,
        input.memo_md,
        version,
        input.model ?? null,
        nowIso,
        nowIso,
        input.last_decision_id ?? null,
        input.decisions_at_generation,
        input.clusters_at_generation,
        input.estimated_tokens,
      );
      pruneStmt.run(
        input.project_root,
        service,
        this.memoHistoryLimit,
        input.project_root,
        service,
      );
      return info.lastInsertRowid as number;
    });
    const id = tx();
    return { id, version };
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
    const service = opts.service_name ?? null;
    const sql =
      service === null
        ? `SELECT * FROM project_memos
             WHERE project_root = ? AND service_name IS NULL
             ORDER BY version DESC, id DESC LIMIT 1`
        : `SELECT * FROM project_memos
             WHERE project_root = ? AND service_name = ?
             ORDER BY version DESC, id DESC LIMIT 1`;
    const stmt = this.db.prepare(sql);
    const row =
      service === null ? stmt.get(opts.project_root) : stmt.get(opts.project_root, service);
    return (row as ProjectMemoRow | undefined) ?? undefined;
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
    const service = opts.service_name ?? null;
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const sql =
      service === null
        ? `SELECT * FROM project_memos
             WHERE project_root = ? AND service_name IS NULL
             ORDER BY version DESC, id DESC LIMIT ?`
        : `SELECT * FROM project_memos
             WHERE project_root = ? AND service_name = ?
             ORDER BY version DESC, id DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    const rows =
      service === null
        ? stmt.all(opts.project_root, limit)
        : stmt.all(opts.project_root, service, limit);
    return rows as ProjectMemoRow[];
  }

  /**
   * Count of decisions whose id > the latest memo's `last_decision_id`,
   * scoped to the same project (+ optional service). Drives the auto-
   * regen threshold in `regenerate_project_memo`. When no prior memo
   * exists, returns the total active decision count in scope.
   */
  countDecisionsSinceLastMemo(opts: { project_root: string; service_name?: string }): number {
    const prev = this.getLatestProjectMemo({
      project_root: opts.project_root,
      service_name: opts.service_name,
    });
    const service = opts.service_name ?? null;
    if (!prev || prev.last_decision_id === null) {
      // No prior memo — count of active rows in scope.
      const conditions: string[] = ['project_root = ?', 'valid_until IS NULL'];
      const params: unknown[] = [opts.project_root];
      if (service !== null) {
        conditions.push('service_name = ?');
        params.push(service);
      }
      const row = this.db
        .prepare(`SELECT COUNT(*) as c FROM decisions WHERE ${conditions.join(' AND ')}`)
        .get(...params) as { c: number };
      return row.c;
    }
    const conditions: string[] = ['project_root = ?', 'id > ?', 'valid_until IS NULL'];
    const params: unknown[] = [opts.project_root, prev.last_decision_id];
    if (service !== null) {
      conditions.push('service_name = ?');
      params.push(service);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM decisions WHERE ${conditions.join(' AND ')}`)
      .get(...params) as { c: number };
    return row.c;
  }
}
