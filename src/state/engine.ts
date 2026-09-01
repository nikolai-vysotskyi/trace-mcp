import type Database from 'better-sqlite3';
import {
  AgentExecutionStateSchema,
  type AgentExecutionState,
  type AgentExecutionStateInput,
  type AgentStatus,
} from './schema.js';
import { applyMergePatch, createMergePatch } from './merge-patch.js';
import {
  CheckpointNotFoundError,
  RevisionNotFoundError,
  StateNotFoundError,
  StateValidationError,
  TaskAlreadyExistsError,
} from './errors.js';
import type {
  ListStatesFilter,
  StateCheckpointRecord,
  StateRecord,
  StateRevisionRecord,
} from './types.js';

interface AgentStateRow {
  task_id: string;
  goal: string;
  status: string;
  state_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AgentStateRevisionRow {
  id: number;
  task_id: string;
  version: number;
  patch_json: string;
  created_at: string;
}

interface AgentStateCheckpointRow {
  id: number;
  task_id: string;
  label: string;
  state_json: string;
  created_at: string;
}

export class StateEngine {
  constructor(public readonly db: Database.Database) {
    StateEngine.ensureTables(db);
  }

  /**
   * Ensures the SQLite tables and indexes for agent state management exist.
   */
  public static ensureTables(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_states (
          task_id     TEXT PRIMARY KEY,
          goal        TEXT NOT NULL,
          status      TEXT NOT NULL,
          state_json  TEXT NOT NULL,
          version     INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_agent_states_status ON agent_states(status);
      CREATE INDEX IF NOT EXISTS idx_agent_states_updated ON agent_states(updated_at);

      CREATE TABLE IF NOT EXISTS agent_state_revisions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id     TEXT NOT NULL REFERENCES agent_states(task_id) ON DELETE CASCADE,
          version     INTEGER NOT NULL,
          patch_json  TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(task_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_state_revisions_task ON agent_state_revisions(task_id);

      CREATE TABLE IF NOT EXISTS agent_state_checkpoints (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id     TEXT NOT NULL REFERENCES agent_states(task_id) ON DELETE CASCADE,
          label       TEXT NOT NULL,
          state_json  TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(task_id, label)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_state_checkpoints_task ON agent_state_checkpoints(task_id);
    `);
  }

  /**
   * Initializes a new agent execution state.
   */
  public initState(input: AgentExecutionStateInput): StateRecord {
    const parseResult = AgentExecutionStateSchema.safeParse(input);
    if (!parseResult.success) {
      const taskId =
        typeof input === 'object' && input !== null && 'task_id' in input
          ? String((input as { task_id: unknown }).task_id)
          : 'unknown';
      throw new StateValidationError(taskId, parseResult.error.message, parseResult.error.issues);
    }

    const state = parseResult.data;
    const existing = this.db
      .prepare('SELECT task_id FROM agent_states WHERE task_id = ?')
      .get(state.task_id) as { task_id: string } | undefined;

    if (existing) {
      throw new TaskAlreadyExistsError(state.task_id);
    }

    const now = new Date().toISOString();
    const version = 1;
    const stateJson = JSON.stringify(state);

    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO agent_states (task_id, goal, status, state_json, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(state.task_id, state.goal, state.status, stateJson, version, now, now);

      this.db
        .prepare(
          `INSERT INTO agent_state_revisions (task_id, version, patch_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(state.task_id, version, stateJson, now);
    })();

    return {
      taskId: state.task_id,
      goal: state.goal,
      status: state.status,
      state,
      version,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Gets the current state record for a task, or null if not found.
   */
  public getState(taskId: string): StateRecord | null {
    const row = this.db
      .prepare(
        `SELECT task_id, goal, status, state_json, version, created_at, updated_at
         FROM agent_states
         WHERE task_id = ?`,
      )
      .get(taskId) as AgentStateRow | undefined;

    if (!row) {
      return null;
    }

    const state = JSON.parse(row.state_json) as AgentExecutionState;
    return {
      taskId: row.task_id,
      goal: row.goal,
      status: row.status as AgentStatus,
      state,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Gets the current state record for a task, throwing StateNotFoundError if missing.
   */
  public getStateRequired(taskId: string): StateRecord {
    const state = this.getState(taskId);
    if (!state) {
      throw new StateNotFoundError(taskId);
    }
    return state;
  }

  /**
   * Applies an RFC 7396 JSON Merge Patch to the task's state atomically.
   */
  public patchState(taskId: string, patch: Record<string, unknown>): StateRecord {
    const row = this.db
      .prepare(
        `SELECT task_id, goal, status, state_json, version, created_at, updated_at
         FROM agent_states
         WHERE task_id = ?`,
      )
      .get(taskId) as AgentStateRow | undefined;

    if (!row) {
      throw new StateNotFoundError(taskId);
    }

    const currentState = JSON.parse(row.state_json);
    const patchedCandidate = applyMergePatch(currentState, patch) as Record<string, unknown>;

    // Enforce immutable task_id
    patchedCandidate.task_id = taskId;

    const parseResult = AgentExecutionStateSchema.safeParse(patchedCandidate);
    if (!parseResult.success) {
      throw new StateValidationError(taskId, parseResult.error.message, parseResult.error.issues);
    }

    const nextState = parseResult.data;
    const nextVersion = row.version + 1;
    const now = new Date().toISOString();
    const nextStateJson = JSON.stringify(nextState);
    const patchJson = JSON.stringify(patch);

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_states
           SET goal = ?, status = ?, state_json = ?, version = ?, updated_at = ?
           WHERE task_id = ?`,
        )
        .run(nextState.goal, nextState.status, nextStateJson, nextVersion, now, taskId);

      this.db
        .prepare(
          `INSERT INTO agent_state_revisions (task_id, version, patch_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(taskId, nextVersion, patchJson, now);
    })();

    return {
      taskId,
      goal: nextState.goal,
      status: nextState.status,
      state: nextState,
      version: nextVersion,
      createdAt: row.created_at,
      updatedAt: now,
    };
  }

  /**
   * Creates or updates a named checkpoint of the current state.
   */
  public createCheckpoint(taskId: string, label: string): StateCheckpointRecord {
    if (!label || label.trim().length === 0) {
      throw new StateValidationError(taskId, 'Checkpoint label cannot be empty');
    }

    const row = this.db
      .prepare(`SELECT task_id, state_json FROM agent_states WHERE task_id = ?`)
      .get(taskId) as Pick<AgentStateRow, 'task_id' | 'state_json'> | undefined;

    if (!row) {
      throw new StateNotFoundError(taskId);
    }

    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_state_checkpoints (task_id, label, state_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(taskId, label, row.state_json, now);

    return {
      id: Number(result.lastInsertRowid),
      taskId,
      label,
      state: JSON.parse(row.state_json) as AgentExecutionState,
      createdAt: now,
    };
  }

  /**
   * Gets a specific checkpoint by label.
   */
  public getCheckpoint(taskId: string, label: string): StateCheckpointRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, task_id, label, state_json, created_at
         FROM agent_state_checkpoints
         WHERE task_id = ? AND label = ?`,
      )
      .get(taskId, label) as AgentStateCheckpointRow | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      taskId: row.task_id,
      label: row.label,
      state: JSON.parse(row.state_json) as AgentExecutionState,
      createdAt: row.created_at,
    };
  }

  /**
   * Lists all checkpoints for a task.
   */
  public listCheckpoints(taskId: string): StateCheckpointRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, task_id, label, state_json, created_at
         FROM agent_state_checkpoints
         WHERE task_id = ?
         ORDER BY id ASC`,
      )
      .all(taskId) as AgentStateCheckpointRow[];

    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      label: r.label,
      state: JSON.parse(r.state_json) as AgentExecutionState,
      createdAt: r.created_at,
    }));
  }

  /**
   * Rolls back the state to a previously saved checkpoint.
   */
  public rollbackToCheckpoint(taskId: string, label: string): StateRecord {
    const stateRow = this.db
      .prepare(
        `SELECT task_id, goal, status, state_json, version, created_at, updated_at
         FROM agent_states
         WHERE task_id = ?`,
      )
      .get(taskId) as AgentStateRow | undefined;

    if (!stateRow) {
      throw new StateNotFoundError(taskId);
    }

    const cpRow = this.db
      .prepare(
        `SELECT id, task_id, label, state_json, created_at
         FROM agent_state_checkpoints
         WHERE task_id = ? AND label = ?`,
      )
      .get(taskId, label) as AgentStateCheckpointRow | undefined;

    if (!cpRow) {
      throw new CheckpointNotFoundError(taskId, label);
    }

    const checkpointState = JSON.parse(cpRow.state_json);
    const parseResult = AgentExecutionStateSchema.safeParse(checkpointState);
    if (!parseResult.success) {
      throw new StateValidationError(
        taskId,
        `Corrupt checkpoint state: ${parseResult.error.message}`,
        parseResult.error.issues,
      );
    }

    const restoredState = parseResult.data;
    const nextVersion = stateRow.version + 1;
    const now = new Date().toISOString();
    const restoredJson = JSON.stringify(restoredState);
    const diffPatch = createMergePatch(JSON.parse(stateRow.state_json), restoredState) ?? {};

    const revisionPayload = JSON.stringify({
      _rollback_to_checkpoint: label,
      patch: diffPatch,
    });

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_states
           SET goal = ?, status = ?, state_json = ?, version = ?, updated_at = ?
           WHERE task_id = ?`,
        )
        .run(restoredState.goal, restoredState.status, restoredJson, nextVersion, now, taskId);

      this.db
        .prepare(
          `INSERT INTO agent_state_revisions (task_id, version, patch_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(taskId, nextVersion, revisionPayload, now);
    })();

    return {
      taskId,
      goal: restoredState.goal,
      status: restoredState.status,
      state: restoredState,
      version: nextVersion,
      createdAt: stateRow.created_at,
      updatedAt: now,
    };
  }

  /**
   * Rolls back the state to a specific historical revision version.
   */
  public rollbackToRevision(taskId: string, targetVersion: number): StateRecord {
    const stateRow = this.db
      .prepare(
        `SELECT task_id, goal, status, state_json, version, created_at, updated_at
         FROM agent_states
         WHERE task_id = ?`,
      )
      .get(taskId) as AgentStateRow | undefined;

    if (!stateRow) {
      throw new StateNotFoundError(taskId);
    }

    if (targetVersion < 1 || targetVersion > stateRow.version) {
      throw new RevisionNotFoundError(taskId, targetVersion);
    }

    const revisionRows = this.db
      .prepare(
        `SELECT id, task_id, version, patch_json, created_at
         FROM agent_state_revisions
         WHERE task_id = ? AND version <= ?
         ORDER BY version ASC`,
      )
      .all(taskId, targetVersion) as AgentStateRevisionRow[];

    if (revisionRows.length === 0 || revisionRows[0].version !== 1) {
      throw new RevisionNotFoundError(taskId, targetVersion);
    }

    // Reconstruct state up to targetVersion
    let reconstructed: unknown = JSON.parse(revisionRows[0].patch_json);
    for (let i = 1; i < revisionRows.length; i++) {
      const rev = revisionRows[i];
      const patchData = JSON.parse(rev.patch_json);
      // If revision was a rollback with embedded state
      if (patchData && typeof patchData === 'object' && 'state' in patchData) {
        reconstructed = patchData.state;
      } else {
        reconstructed = applyMergePatch(reconstructed, patchData);
      }
    }

    const parseResult = AgentExecutionStateSchema.safeParse(reconstructed);
    if (!parseResult.success) {
      throw new StateValidationError(
        taskId,
        `Cannot reconstruct valid state at revision ${targetVersion}: ${parseResult.error.message}`,
        parseResult.error.issues,
      );
    }

    const restoredState = parseResult.data;
    const nextVersion = stateRow.version + 1;
    const now = new Date().toISOString();
    const restoredJson = JSON.stringify(restoredState);
    const diffPatch = createMergePatch(JSON.parse(stateRow.state_json), restoredState) ?? {};

    const revisionPayload = JSON.stringify({
      _rollback_to_version: targetVersion,
      patch: diffPatch,
    });

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE agent_states
           SET goal = ?, status = ?, state_json = ?, version = ?, updated_at = ?
           WHERE task_id = ?`,
        )
        .run(restoredState.goal, restoredState.status, restoredJson, nextVersion, now, taskId);

      this.db
        .prepare(
          `INSERT INTO agent_state_revisions (task_id, version, patch_json, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(taskId, nextVersion, revisionPayload, now);
    })();

    return {
      taskId,
      goal: restoredState.goal,
      status: restoredState.status,
      state: restoredState,
      version: nextVersion,
      createdAt: stateRow.created_at,
      updatedAt: now,
    };
  }

  /**
   * Lists all historical revisions for a task.
   */
  public getRevisions(taskId: string): StateRevisionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, task_id, version, patch_json, created_at
         FROM agent_state_revisions
         WHERE task_id = ?
         ORDER BY version ASC`,
      )
      .all(taskId) as AgentStateRevisionRow[];

    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      version: r.version,
      patch: JSON.parse(r.patch_json),
      createdAt: r.created_at,
    }));
  }

  /**
   * Gets a single revision by version number.
   */
  public getRevision(taskId: string, version: number): StateRevisionRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, task_id, version, patch_json, created_at
         FROM agent_state_revisions
         WHERE task_id = ? AND version = ?`,
      )
      .get(taskId, version) as AgentStateRevisionRow | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      taskId: row.task_id,
      version: row.version,
      patch: JSON.parse(row.patch_json),
      createdAt: row.created_at,
    };
  }

  /**
   * Lists active agent states with optional filtering by status, limit, offset.
   */
  public listStates(filter: ListStatesFilter = {}): StateRecord[] {
    let sql = `SELECT task_id, goal, status, state_json, version, created_at, updated_at FROM agent_states`;
    const params: (string | number)[] = [];

    if (filter.status) {
      sql += ` WHERE status = ?`;
      params.push(filter.status);
    }

    sql += ` ORDER BY updated_at DESC`;

    if (filter.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(filter.limit);
      if (filter.offset !== undefined) {
        sql += ` OFFSET ?`;
        params.push(filter.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as AgentStateRow[];

    return rows.map((row) => ({
      taskId: row.task_id,
      goal: row.goal,
      status: row.status as AgentStatus,
      state: JSON.parse(row.state_json) as AgentExecutionState,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Deletes an agent state and all associated revisions and checkpoints.
   */
  public deleteState(taskId: string): boolean {
    let changed = false;
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM agent_state_checkpoints WHERE task_id = ?`).run(taskId);
      this.db.prepare(`DELETE FROM agent_state_revisions WHERE task_id = ?`).run(taskId);
      const res = this.db.prepare(`DELETE FROM agent_states WHERE task_id = ?`).run(taskId);
      changed = res.changes > 0;
    })();
    return changed;
  }
}
