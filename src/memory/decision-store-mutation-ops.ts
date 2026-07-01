/**
 * Decision write-path — extracted from `DecisionStore` (Task: god-class
 * decomposition). Owns the mutation surface over the `decisions` table:
 *
 *   - `getDecision`               — single-row lookup (shared by every op class).
 *   - `addDecision` / `addDecisions` — insert (with optional state-key
 *     supersession) + bulk insert.
 *   - `addDecisionWithSupersession` / `findSupersedable` / `supersedeConflicting`
 *     — Task-11 state-key supersession heuristic.
 *   - `updateDecision` / `invalidateDecision` / `deleteDecision`.
 *
 * All of these depend only on `this.db`, the optional audit logger, and the
 * pure `relativizeUnderRoot` path helper. The module owns `auditEmit` (the
 * best-effort JSONL mirror) so no store callback is needed.
 *
 * `DecisionStore` holds one `MutationOperations` instance and delegates its
 * public mutation methods to it verbatim — the public API and behavior are
 * unchanged, only the implementation moved.
 */

import type Database from 'better-sqlite3';
import { logger } from '../logger.js';
import { relativizeUnderRoot } from '../utils/path-relativize.js';
import type { AuditLogger } from './decision-audit-log.js';
import type { DecisionRow, DecisionInput } from './decision-types.js';

export class MutationOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly auditLogger: AuditLogger | null,
  ) {}

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

  getDecision(id: number): DecisionRow | undefined {
    return this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as
      | DecisionRow
      | undefined;
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
  findSupersedable(input: DecisionInput): number[] {
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
}
