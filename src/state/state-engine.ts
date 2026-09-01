/**
 * StateEngine — SQLite-backed structured execution state engine.
 *
 * Implements persistent state storage, atomic RFC 7396 merge patching with Zod validation,
 * revisions history, and named checkpoints/rollback.
 */

import Database, { type Database as BetterSqliteDatabase } from 'better-sqlite3';
import { logger } from '../logger.js';
import { restrictDbPerms } from '../shared/db-perms.js';
import { applyJsonMergePatch } from './json-merge-patch.js';
import { AgentExecutionStateSchema } from './schema.js';
import type {
  AgentDeadEnd,
  AgentExecutionPlan,
  AgentExecutionState,
  AgentExecutionStatus,
  AgentStep,
  CheckpointResult,
  PatchStateResult,
  RollbackResult,
  StateCheckpointRow,
  StateRevisionRow,
  StateRow,
  StateSummaryItem,
} from './types.js';

const STATE_ENGINE_DDL = `
CREATE TABLE IF NOT EXISTS agent_states (
    task_id         TEXT PRIMARY KEY,
    goal            TEXT NOT NULL,
    status          TEXT NOT NULL,
    state_json      TEXT NOT NULL,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_state_revisions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         TEXT NOT NULL,
    version         INTEGER NOT NULL,
    patch_json      TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_state_checkpoints (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         TEXT NOT NULL,
    label           TEXT NOT NULL,
    state_json      TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_revisions_task_ver
    ON agent_state_revisions(task_id, version);

CREATE INDEX IF NOT EXISTS idx_state_checkpoints_task
    ON agent_state_checkpoints(task_id);
`;

export type StateChangeListener = (event: {
  taskId: string;
  version: number;
  state: AgentExecutionState;
}) => void;

export class StateEngine {
  readonly db: BetterSqliteDatabase;
  private readonly listeners = new Set<StateChangeListener>();

  constructor(dbPathOrDb: string | BetterSqliteDatabase) {
    if (typeof dbPathOrDb === 'string') {
      this.db = new Database(dbPathOrDb);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('foreign_keys = ON');
      restrictDbPerms(dbPathOrDb);
    } else {
      this.db = dbPathOrDb;
    }

    this.db.exec(STATE_ENGINE_DDL);
  }

  /**
   * Subscribe to state mutations. Returns unsubscribe function.
   */
  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(taskId: string, version: number, state: AgentExecutionState): void {
    for (const listener of this.listeners) {
      try {
        listener({ taskId, version, state });
      } catch (err) {
        logger.warn({ err, taskId }, 'StateEngine listener failed');
      }
    }
  }

  /**
   * Initialize a new execution state for a task.
   */
  initState(
    taskId: string,
    goal: string,
    initialPlan?: string[] | AgentStep[],
    metadata?: Record<string, unknown>,
  ): AgentExecutionState {
    const now = new Date().toISOString();

    let steps: AgentStep[] = [];
    let activeStepId: string | null = null;

    if (Array.isArray(initialPlan)) {
      if (initialPlan.length > 0 && typeof initialPlan[0] === 'string') {
        steps = (initialPlan as string[]).map((title, idx) => ({
          id: `step_${idx + 1}`,
          title: title.trim(),
          status: (idx === 0 ? 'in_progress' : 'pending') as AgentStep['status'],
        }));
        activeStepId = steps[0]?.id ?? null;
      } else if (initialPlan.length > 0 && typeof initialPlan[0] === 'object') {
        steps = initialPlan as AgentStep[];
        activeStepId = steps.find((s) => s.status === 'in_progress')?.id ?? steps[0]?.id ?? null;
      }
    }

    const plan: AgentExecutionPlan = {
      steps,
      active_step_id: activeStepId,
    };

    const rawState: AgentExecutionState = {
      task_id: taskId,
      goal,
      status: 'in_progress',
      plan,
      facts: {
        architecture_notes: [],
        key_symbols: [],
        learned_constraints: [],
      },
      working_context: {
        modified_files: [],
        test_targets: [],
        open_questions: [],
      },
      blockers_and_dead_ends: {
        last_error: null,
        dead_ends: [],
      },
      next_action: steps.length > 0 ? steps[0]?.title : null,
      metadata: metadata ?? {},
    };

    const validatedState = AgentExecutionStateSchema.parse(rawState);
    const stateJson = JSON.stringify(validatedState);

    const initTx = this.db.transaction(() => {
      this.db
        .prepare(
          `
        INSERT INTO agent_states (task_id, goal, status, state_json, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          goal = excluded.goal,
          status = excluded.status,
          state_json = excluded.state_json,
          version = agent_states.version + 1,
          updated_at = excluded.updated_at
      `,
        )
        .run(taskId, goal, validatedState.status, stateJson, now, now);

      this.db
        .prepare(
          `
        INSERT INTO agent_state_revisions (task_id, version, patch_json, created_at)
        VALUES (?, 1, ?, ?)
      `,
        )
        .run(taskId, JSON.stringify({ init: true, state: validatedState }), now);
    });

    initTx();
    this.notify(taskId, 1, validatedState);
    return validatedState;
  }

  /**
   * Get the current state of a task by taskId.
   */
  getState(taskId: string): {
    state: AgentExecutionState;
    version: number;
    createdAt: string;
    updatedAt: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT task_id, goal, status, state_json, version, created_at, updated_at
         FROM agent_states WHERE task_id = ?`,
      )
      .get(taskId) as StateRow | undefined;

    if (!row) return null;

    try {
      const parsed = JSON.parse(row.state_json);
      const state = AgentExecutionStateSchema.parse(parsed);
      return {
        state,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (err) {
      logger.error({ err, taskId }, 'Failed to parse stored state_json');
      throw new Error(`Corrupt state JSON for task ${taskId}: ${(err as Error).message}`);
    }
  }

  /**
   * Apply an RFC 7396 JSON Merge Patch to an existing task state.
   */
  patchState(taskId: string, patch: Record<string, unknown> | string): PatchStateResult {
    const current = this.getState(taskId);
    if (!current) {
      throw new Error(
        `Task state not found for task_id: "${taskId}". Call trace_state_init first.`,
      );
    }

    const patchObj = typeof patch === 'string' ? JSON.parse(patch) : patch;
    const merged = applyJsonMergePatch(current.state, patchObj);

    // Validate merged state strictly against schema
    const parseResult = AgentExecutionStateSchema.safeParse(merged);
    if (!parseResult.success) {
      const issues = parseResult.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join(', ');
      throw new Error(`Invalid state after applying patch: ${issues}`);
    }

    const nextState = parseResult.data;
    const nextVersion = current.version + 1;
    const stateJson = JSON.stringify(nextState);
    const patchJson = JSON.stringify(patchObj);
    const now = new Date().toISOString();

    const patchTx = this.db.transaction(() => {
      this.db
        .prepare(
          `
        UPDATE agent_states
        SET goal = ?, status = ?, state_json = ?, version = ?, updated_at = ?
        WHERE task_id = ?
      `,
        )
        .run(nextState.goal, nextState.status, stateJson, nextVersion, now, taskId);

      this.db
        .prepare(
          `
        INSERT INTO agent_state_revisions (task_id, version, patch_json, created_at)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(taskId, nextVersion, patchJson, now);
    });

    patchTx();
    this.notify(taskId, nextVersion, nextState);

    return {
      success: true,
      version: nextVersion,
      active_step_id: nextState.plan.active_step_id,
      status: nextState.status,
      state: nextState,
    };
  }

  /**
   * Create a named checkpoint for a task state.
   */
  createCheckpoint(taskId: string, label: string): CheckpointResult {
    const current = this.getState(taskId);
    if (!current) {
      throw new Error(`Task state not found for task_id: "${taskId}".`);
    }

    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
      INSERT INTO agent_state_checkpoints (task_id, label, state_json, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(taskId, label.trim(), JSON.stringify(current.state), now);

    return {
      id: Number(result.lastInsertRowid),
      taskId,
      label: label.trim(),
      version: current.version,
      createdAt: now,
    };
  }

  /**
   * Rollback task state to a saved checkpoint by id or label.
   */
  rollbackToCheckpoint(taskId: string, checkpointIdOrLabel: string | number): RollbackResult {
    let row: StateCheckpointRow | undefined;

    if (typeof checkpointIdOrLabel === 'number' || /^\d+$/.test(String(checkpointIdOrLabel))) {
      row = this.db
        .prepare(
          `SELECT id, task_id, label, state_json, created_at
           FROM agent_state_checkpoints WHERE task_id = ? AND id = ?`,
        )
        .get(taskId, Number(checkpointIdOrLabel)) as StateCheckpointRow | undefined;
    }

    if (!row) {
      row = this.db
        .prepare(
          `SELECT id, task_id, label, state_json, created_at
           FROM agent_state_checkpoints
           WHERE task_id = ? AND label = ?
           ORDER BY id DESC LIMIT 1`,
        )
        .get(taskId, String(checkpointIdOrLabel).trim()) as StateCheckpointRow | undefined;
    }

    if (!row) {
      throw new Error(`Checkpoint "${checkpointIdOrLabel}" not found for task_id: "${taskId}".`);
    }

    const restoredState = AgentExecutionStateSchema.parse(JSON.parse(row.state_json));
    const current = this.getState(taskId);
    const nextVersion = (current?.version ?? 1) + 1;
    const now = new Date().toISOString();

    const rollbackTx = this.db.transaction(() => {
      this.db
        .prepare(
          `
        UPDATE agent_states
        SET goal = ?, status = ?, state_json = ?, version = ?, updated_at = ?
        WHERE task_id = ?
      `,
        )
        .run(
          restoredState.goal,
          restoredState.status,
          JSON.stringify(restoredState),
          nextVersion,
          now,
          taskId,
        );

      this.db
        .prepare(
          `
        INSERT INTO agent_state_revisions (task_id, version, patch_json, created_at)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(
          taskId,
          nextVersion,
          JSON.stringify({ rollback_to_checkpoint: row?.label, checkpoint_id: row?.id }),
          now,
        );
    });

    rollbackTx();
    this.notify(taskId, nextVersion, restoredState);

    return {
      success: true,
      version: nextVersion,
      rolledBackTo: row.label,
      state: restoredState,
    };
  }

  /**
   * Fast shortcut to record a dead end into task state.
   */
  addDeadEnd(taskId: string, reason: string, approach?: string): PatchStateResult {
    const current = this.getState(taskId);
    if (!current) {
      throw new Error(`Task state not found for task_id: "${taskId}".`);
    }

    const deadEnd: AgentDeadEnd = {
      approach: approach?.trim() || current.state.next_action || 'Current approach',
      reason: reason.trim(),
      timestamp: new Date().toISOString(),
    };

    const existingDeadEnds = current.state.blockers_and_dead_ends?.dead_ends ?? [];
    const patch = {
      blockers_and_dead_ends: {
        dead_ends: [...existingDeadEnds, deadEnd],
        last_error: reason.trim(),
      },
    };

    return this.patchState(taskId, patch);
  }

  /**
   * List all stored task states.
   */
  listStates(limit = 50): StateSummaryItem[] {
    const rows = this.db
      .prepare(
        `SELECT task_id, goal, status, state_json, version, updated_at
         FROM agent_states
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      task_id: string;
      goal: string;
      status: string;
      state_json: string;
      version: number;
      updated_at: string;
    }>;

    return rows.map((r) => {
      let activeStepId: string | null = null;
      try {
        const parsed = JSON.parse(r.state_json);
        activeStepId = parsed.plan?.active_step_id ?? null;
      } catch {
        /* ignore */
      }

      return {
        taskId: r.task_id,
        goal: r.goal,
        status: r.status as AgentExecutionStatus,
        version: r.version,
        activeStepId,
        updatedAt: r.updated_at,
      };
    });
  }

  /**
   * Delete a task state and its revisions/checkpoints.
   */
  deleteState(taskId: string): boolean {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM agent_state_checkpoints WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM agent_state_revisions WHERE task_id = ?').run(taskId);
      const res = this.db.prepare('DELETE FROM agent_states WHERE task_id = ?').run(taskId);
      return res.changes > 0;
    });

    return tx();
  }

  /**
   * Close the underlying SQLite database connection.
   */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}
