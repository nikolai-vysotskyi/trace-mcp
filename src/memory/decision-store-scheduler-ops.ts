/**
 * Scheduler-state persistence — extracted from `DecisionStore` (Task:
 * god-class decomposition). Owns the `scheduler_state` table: durable
 * per-project cooldown bookkeeping for the background MemoryScheduler.
 *
 * The scheduler keeps lastMineAt / lastClusterAt / lastMemoAt / lastTuneAt /
 * consecutiveFailures in memory; persisting them lets a daemon restart skip
 * stages that already ran on the previous boot — avoiding a thundering herd
 * of LLM-backed mine / cluster / memo / tune calls on the first tick.
 *
 * `DecisionStore` holds one `SchedulerStateOperations` instance and delegates
 * its public `getSchedulerState` / `upsertSchedulerState` methods to it
 * verbatim — the public API and behavior are unchanged, only the
 * implementation moved.
 */

import type Database from 'better-sqlite3';
import type { SchedulerStateRow } from './decision-types.js';

export class SchedulerStateOperations {
  constructor(private readonly db: Database.Database) {}

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
}
