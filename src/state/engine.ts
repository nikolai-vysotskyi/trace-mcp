import type Database from 'better-sqlite3';
import { applyJsonMergePatch } from './patch.js';
import { formatState } from './serializer.js';
import {
  type AgentExecutionState,
  AgentExecutionStateSchema,
  type PlanStep,
  type StateCheckpoint,
  type StatePatch,
  type StateRevision,
} from './types.js';

export interface StateEngineOptions {
  db?: Database.Database;
}

export class StateEngine {
  private db?: Database.Database;
  private memoryStates = new Map<string, AgentExecutionState>();
  private memoryRevisions = new Map<string, StateRevision[]>();
  private memoryCheckpoints = new Map<string, StateCheckpoint[]>();

  constructor(options: StateEngineOptions = {}) {
    this.db = options.db;
    if (this.db) {
      this.initSchema();
    }
  }

  private initSchema(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_states (
        task_id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_state_revisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        patch_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_state_checkpoints (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        label TEXT NOT NULL,
        version INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_state_revisions_task ON agent_state_revisions(task_id);
      CREATE INDEX IF NOT EXISTS idx_agent_state_checkpoints_task ON agent_state_checkpoints(task_id);
    `);
  }

  /**
   * Initializes a new state for a task.
   */
  public init(taskId: string, goal: string, initialPlan: string[] = []): AgentExecutionState {
    const now = new Date().toISOString();
    const planSteps: PlanStep[] = initialPlan.map((title, idx) => ({
      id: String(idx + 1),
      title,
      status: idx === 0 ? 'in_progress' : 'pending',
    }));

    const rawState = {
      task_id: taskId,
      goal,
      status: 'running' as const,
      version: 1,
      plan: {
        steps: planSteps,
        active_step_id: planSteps.length > 0 ? planSteps[0].id : null,
      },
      facts: {
        architecture_notes: [],
        key_symbols: [],
      },
      working_context: {
        modified_files: [],
        test_targets: [],
      },
      blockers_and_dead_ends: {
        dead_ends: [],
      },
      created_at: now,
      updated_at: now,
    };

    const state = AgentExecutionStateSchema.parse(rawState);

    if (this.db) {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO agent_states (task_id, goal, status, version, state_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(taskId, goal, state.status, state.version, JSON.stringify(state), now, now);
    } else {
      this.memoryStates.set(taskId, state);
      this.memoryRevisions.set(taskId, []);
      this.memoryCheckpoints.set(taskId, []);
    }

    return state;
  }

  /**
   * Retrieves the current state of a task.
   */
  public get(taskId: string): AgentExecutionState | null {
    if (this.db) {
      const row = this.db
        .prepare('SELECT state_json FROM agent_states WHERE task_id = ?')
        .get(taskId) as { state_json: string } | undefined;
      if (!row) return null;
      return AgentExecutionStateSchema.parse(JSON.parse(row.state_json));
    }
    return this.memoryStates.get(taskId) ?? null;
  }

  /**
   * Retrieves formatted representation ('json' or 'compact').
   */
  public getFormatted(taskId: string, format: 'json' | 'compact' = 'compact'): string | null {
    const state = this.get(taskId);
    if (!state) return null;
    return formatState(state, format);
  }

  /**
   * Applies an RFC 7396 merge patch to the task's state.
   */
  public patch(
    taskId: string,
    patch: StatePatch,
  ): {
    success: true;
    version: number;
    state: AgentExecutionState;
    active_step_id?: string | null;
  } {
    const current = this.get(taskId);
    if (!current) {
      throw new Error(`Task state not found for task_id: ${taskId}`);
    }

    const merged = applyJsonMergePatch(current, patch) as Record<string, unknown>;
    const newVersion = (current.version || 1) + 1;
    const now = new Date().toISOString();

    merged.version = newVersion;
    merged.updated_at = now;
    merged.task_id = taskId; // invariant

    const validated = AgentExecutionStateSchema.parse(merged);
    const revisionId = `${taskId}-rev-${newVersion}`;

    if (this.db) {
      const updateState = this.db.prepare(`
        UPDATE agent_states
        SET goal = ?, status = ?, version = ?, state_json = ?, updated_at = ?
        WHERE task_id = ?
      `);
      const insertRev = this.db.prepare(`
        INSERT INTO agent_state_revisions (id, task_id, version, patch_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      const tx = this.db.transaction(() => {
        updateState.run(
          validated.goal,
          validated.status,
          newVersion,
          JSON.stringify(validated),
          now,
          taskId,
        );
        insertRev.run(revisionId, taskId, newVersion, JSON.stringify(patch), now);
      });
      tx();
    } else {
      this.memoryStates.set(taskId, validated);
      const revs = this.memoryRevisions.get(taskId) ?? [];
      revs.push({
        id: revisionId,
        task_id: taskId,
        version: newVersion,
        patch,
        created_at: now,
      });
      this.memoryRevisions.set(taskId, revs);
    }

    return {
      success: true,
      version: newVersion,
      state: validated,
      active_step_id: validated.plan?.active_step_id,
    };
  }

  /**
   * Convenience method to record a dead-end attempt without sending a full patch.
   */
  public addDeadEnd(taskId: string, reason: string): AgentExecutionState {
    const current = this.get(taskId);
    if (!current) {
      throw new Error(`Task state not found for task_id: ${taskId}`);
    }

    const existingDeadEnds = current.blockers_and_dead_ends?.dead_ends ?? [];
    if (existingDeadEnds.includes(reason)) {
      return current;
    }

    const res = this.patch(taskId, {
      blockers_and_dead_ends: {
        dead_ends: [...existingDeadEnds, reason],
      },
    });
    return res.state;
  }

  /**
   * Creates a named checkpoint.
   */
  public checkpoint(taskId: string, label: string): StateCheckpoint {
    const current = this.get(taskId);
    if (!current) {
      throw new Error(`Task state not found for task_id: ${taskId}`);
    }

    const id = `${taskId}-cp-${Date.now()}`;
    const now = new Date().toISOString();
    const cp: StateCheckpoint = {
      id,
      task_id: taskId,
      label,
      version: current.version,
      state: current,
      created_at: now,
    };

    if (this.db) {
      const stmt = this.db.prepare(`
        INSERT INTO agent_state_checkpoints (id, task_id, label, version, state_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(id, taskId, label, current.version, JSON.stringify(current), now);
    } else {
      const cps = this.memoryCheckpoints.get(taskId) ?? [];
      cps.push(cp);
      this.memoryCheckpoints.set(taskId, cps);
    }

    return cp;
  }

  /**
   * Rolls back the state to a specified checkpoint.
   */
  public rollback(taskId: string, checkpointIdOrLabel: string): AgentExecutionState {
    let checkpoint: StateCheckpoint | undefined;

    if (this.db) {
      const row = this.db
        .prepare(`
        SELECT id, task_id, label, version, state_json, created_at
        FROM agent_state_checkpoints
        WHERE task_id = ? AND (id = ? OR label = ?)
        ORDER BY created_at DESC
        LIMIT 1
      `)
        .get(taskId, checkpointIdOrLabel, checkpointIdOrLabel) as
        | {
            id: string;
            task_id: string;
            label: string;
            version: number;
            state_json: string;
            created_at: string;
          }
        | undefined;

      if (row) {
        checkpoint = {
          id: row.id,
          task_id: row.task_id,
          label: row.label,
          version: row.version,
          state: AgentExecutionStateSchema.parse(JSON.parse(row.state_json)),
          created_at: row.created_at,
        };
      }
    } else {
      const cps = this.memoryCheckpoints.get(taskId) ?? [];
      checkpoint = cps.find((c) => c.id === checkpointIdOrLabel || c.label === checkpointIdOrLabel);
    }

    if (!checkpoint) {
      throw new Error(`Checkpoint '${checkpointIdOrLabel}' not found for task ${taskId}`);
    }

    const restoredState = {
      ...checkpoint.state,
      version: (this.get(taskId)?.version ?? 1) + 1,
      updated_at: new Date().toISOString(),
    };

    if (this.db) {
      const updateState = this.db.prepare(`
        UPDATE agent_states
        SET goal = ?, status = ?, version = ?, state_json = ?, updated_at = ?
        WHERE task_id = ?
      `);
      updateState.run(
        restoredState.goal,
        restoredState.status,
        restoredState.version,
        JSON.stringify(restoredState),
        restoredState.updated_at,
        taskId,
      );
    } else {
      this.memoryStates.set(taskId, restoredState);
    }

    return restoredState;
  }
}
