import type Database from 'better-sqlite3';
import { applyJsonMergePatch } from './merge-patch.js';
import {
  type AgentExecutionState,
  AgentExecutionStateSchema,
  type AgentStateCheckpoint,
  type AgentStateRevision,
  type PlanStep,
} from './types.js';

export function ensureStateSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_states (
      task_id     TEXT PRIMARY KEY,
      goal        TEXT NOT NULL,
      status      TEXT NOT NULL,
      state_json  TEXT NOT NULL,
      version     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_state_revisions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL,
      version     INTEGER NOT NULL,
      patch_json  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_state_revisions_task ON agent_state_revisions(task_id);

    CREATE TABLE IF NOT EXISTS agent_state_checkpoints (
      id          TEXT PRIMARY KEY,
      task_id     TEXT NOT NULL,
      label       TEXT NOT NULL,
      state_json  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_state_checkpoints_task ON agent_state_checkpoints(task_id);
  `);
}

export class StateEngine {
  constructor(public readonly db: Database.Database) {
    ensureStateSchema(this.db);
  }

  /**
   * Initialize a new execution state for a task.
   */
  init(params: { task_id: string; goal: string; initial_plan?: string[] }): AgentExecutionState {
    if (!params.task_id || !params.task_id.trim()) {
      throw new Error('task_id must be a non-empty string');
    }
    if (!params.goal || !params.goal.trim()) {
      throw new Error('goal must be a non-empty string');
    }

    const now = new Date().toISOString();
    const steps: PlanStep[] =
      params.initial_plan && params.initial_plan.length > 0
        ? params.initial_plan.map((desc, idx) => ({
            id: `step_${idx + 1}`,
            description: desc,
            status: idx === 0 ? 'in_progress' : 'pending',
          }))
        : [];

    const activeStepId = steps.length > 0 ? steps[0].id : null;
    const nextAction = steps.length > 0 ? steps[0].description : null;

    const rawState: AgentExecutionState = {
      task_id: params.task_id.trim(),
      goal: params.goal.trim(),
      status: 'in_progress',
      plan: {
        steps,
        active_step_id: activeStepId,
      },
      facts: {
        architecture_notes: [],
        key_symbols: [],
      },
      working_context: {
        modified_files: [],
        diff_summary: null,
        test_targets: [],
      },
      blockers_and_dead_ends: {
        last_error: null,
        dead_ends: [],
      },
      next_action: nextAction,
      version: 1,
      created_at: now,
      updated_at: now,
    };

    const validated = AgentExecutionStateSchema.parse(rawState) as AgentExecutionState;
    const stateJson = JSON.stringify(validated);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO agent_states (task_id, goal, status, state_json, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          validated.task_id,
          validated.goal,
          validated.status,
          stateJson,
          validated.version,
          validated.created_at,
          validated.updated_at,
        );

      this.db
        .prepare(
          `INSERT INTO agent_state_revisions (task_id, version, patch_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          validated.task_id,
          validated.version,
          JSON.stringify({ init: true, goal: validated.goal }),
          validated.created_at,
        );
    });

    tx();
    return validated;
  }

  /**
   * Get current state for a task.
   */
  get(task_id: string): AgentExecutionState | null {
    if (!task_id) return null;
    const row = this.db
      .prepare(`SELECT state_json FROM agent_states WHERE task_id = ?`)
      .get(task_id) as { state_json: string } | undefined;

    if (!row) return null;
    try {
      const parsed = JSON.parse(row.state_json);
      return AgentExecutionStateSchema.parse(parsed) as AgentExecutionState;
    } catch {
      return null;
    }
  }

  /**
   * Apply an RFC 7396 JSON Merge Patch to the state.
   */
  patch(params: { task_id: string; patch: Record<string, unknown> }): {
    success: true;
    version: number;
    active_step_id: string | null;
    state: AgentExecutionState;
  } {
    const currentState = this.get(params.task_id);
    if (!currentState) {
      throw new Error(`State for task "${params.task_id}" not found`);
    }

    if (!params.patch || typeof params.patch !== 'object') {
      throw new Error('patch must be an object');
    }

    const merged = applyJsonMergePatch<AgentExecutionState>(currentState, params.patch);
    merged.task_id = currentState.task_id; // preserve immutable task_id
    merged.version = currentState.version + 1;
    merged.updated_at = new Date().toISOString();
    merged.created_at = currentState.created_at;

    const validated = AgentExecutionStateSchema.parse(merged) as AgentExecutionState;
    const stateJson = JSON.stringify(validated);
    const patchJson = JSON.stringify(params.patch);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_states
           SET goal = ?, status = ?, state_json = ?, version = ?, updated_at = ?
           WHERE task_id = ?`,
        )
        .run(
          validated.goal,
          validated.status,
          stateJson,
          validated.version,
          validated.updated_at,
          validated.task_id,
        );

      this.db
        .prepare(
          `INSERT INTO agent_state_revisions (task_id, version, patch_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(validated.task_id, validated.version, patchJson, validated.updated_at);
    });

    tx();

    return {
      success: true,
      version: validated.version,
      active_step_id: validated.plan?.active_step_id ?? null,
      state: validated,
    };
  }

  /**
   * Create a named checkpoint of the current execution state.
   */
  checkpoint(params: { task_id: string; label: string }): {
    success: true;
    checkpoint_id: string;
    label: string;
    version: number;
  } {
    const currentState = this.get(params.task_id);
    if (!currentState) {
      throw new Error(`State for task "${params.task_id}" not found`);
    }
    if (!params.label || !params.label.trim()) {
      throw new Error('label must be a non-empty string');
    }

    const now = new Date().toISOString();
    const cleanLabel = params.label.trim();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const checkpointId = `chk_${Date.now()}_${randomSuffix}`;
    const stateJson = JSON.stringify(currentState);

    this.db
      .prepare(
        `INSERT INTO agent_state_checkpoints (id, task_id, label, state_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(checkpointId, currentState.task_id, cleanLabel, stateJson, now);

    return {
      success: true,
      checkpoint_id: checkpointId,
      label: cleanLabel,
      version: currentState.version,
    };
  }

  /**
   * Roll back to a previously saved checkpoint.
   */
  rollback(params: { task_id: string; checkpoint_id_or_label: string }): {
    success: true;
    rolled_back_to: string;
    version: number;
    state: AgentExecutionState;
  } {
    const currentState = this.get(params.task_id);
    if (!currentState) {
      throw new Error(`State for task "${params.task_id}" not found`);
    }

    const target = params.checkpoint_id_or_label.trim();
    const row = this.db
      .prepare(
        `SELECT id, label, state_json FROM agent_state_checkpoints
         WHERE task_id = ? AND (id = ? OR label = ?)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(params.task_id, target, target) as
      | { id: string; label: string; state_json: string }
      | undefined;

    if (!row) {
      throw new Error(`Checkpoint "${target}" for task "${params.task_id}" not found`);
    }

    const restored = JSON.parse(row.state_json) as AgentExecutionState;
    restored.task_id = currentState.task_id;
    restored.version = currentState.version + 1;
    restored.updated_at = new Date().toISOString();
    restored.created_at = currentState.created_at;

    const validated = AgentExecutionStateSchema.parse(restored) as AgentExecutionState;
    const stateJson = JSON.stringify(validated);
    const rollbackPatchJson = JSON.stringify({
      rollback_to_checkpoint: row.id,
      label: row.label,
    });

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_states
           SET goal = ?, status = ?, state_json = ?, version = ?, updated_at = ?
           WHERE task_id = ?`,
        )
        .run(
          validated.goal,
          validated.status,
          stateJson,
          validated.version,
          validated.updated_at,
          validated.task_id,
        );

      this.db
        .prepare(
          `INSERT INTO agent_state_revisions (task_id, version, patch_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(validated.task_id, validated.version, rollbackPatchJson, validated.updated_at);
    });

    tx();

    return {
      success: true,
      rolled_back_to: row.label,
      version: validated.version,
      state: validated,
    };
  }

  /**
   * Shortcut to record a dead-end reason into blockers_and_dead_ends.
   */
  addDeadEnd(params: { task_id: string; reason: string }): {
    success: true;
    version: number;
    dead_ends_count: number;
    state: AgentExecutionState;
  } {
    const currentState = this.get(params.task_id);
    if (!currentState) {
      throw new Error(`State for task "${params.task_id}" not found`);
    }
    if (!params.reason || !params.reason.trim()) {
      throw new Error('reason must be a non-empty string');
    }

    const deadEnds = [
      ...(currentState.blockers_and_dead_ends?.dead_ends ?? []),
      params.reason.trim(),
    ];

    const res = this.patch({
      task_id: params.task_id,
      patch: {
        blockers_and_dead_ends: {
          dead_ends: deadEnds,
        },
      },
    });

    return {
      success: true,
      version: res.version,
      dead_ends_count: res.state.blockers_and_dead_ends.dead_ends.length,
      state: res.state,
    };
  }

  /**
   * List revisions for a task.
   */
  listRevisions(task_id: string): AgentStateRevision[] {
    return this.db
      .prepare(
        `SELECT id, task_id, version, patch_json, created_at
         FROM agent_state_revisions
         WHERE task_id = ?
         ORDER BY version ASC`,
      )
      .all(task_id) as AgentStateRevision[];
  }

  /**
   * List checkpoints for a task.
   */
  listCheckpoints(task_id: string): AgentStateCheckpoint[] {
    return this.db
      .prepare(
        `SELECT id, task_id, label, state_json, created_at
         FROM agent_state_checkpoints
         WHERE task_id = ?
         ORDER BY created_at ASC`,
      )
      .all(task_id) as AgentStateCheckpoint[];
  }
}
