import path from 'node:path';
import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import {
  CheckpointNotFoundError,
  RevisionNotFoundError,
  StateEngine,
  StateNotFoundError,
  StateValidationError,
  TaskAlreadyExistsError,
} from '../../src/state/index.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('StateEngine', () => {
  let db: Database.Database;
  let engine: StateEngine;

  beforeEach(() => {
    db = initializeDatabase(':memory:');
    engine = new StateEngine(db);
  });

  describe('initState', () => {
    it('initializes a new state with version 1 and writes initial revision', () => {
      const record = engine.initState({
        task_id: 'task-1',
        goal: 'Ship Phase 1 StateEngine',
      });

      expect(record.taskId).toBe('task-1');
      expect(record.goal).toBe('Ship Phase 1 StateEngine');
      expect(record.status).toBe('in_progress');
      expect(record.version).toBe(1);
      expect(record.state.plan.steps).toEqual([]);
      expect(record.createdAt).toBeDefined();
      expect(record.updatedAt).toBeDefined();

      // Check DB directly
      const rawState = db.prepare('SELECT * FROM agent_states WHERE task_id = ?').get('task-1') as {
        goal: string;
        status: string;
        version: number;
      };
      expect(rawState.goal).toBe('Ship Phase 1 StateEngine');
      expect(rawState.status).toBe('in_progress');
      expect(rawState.version).toBe(1);

      // Check revision 1
      const revisions = engine.getRevisions('task-1');
      expect(revisions.length).toBe(1);
      expect(revisions[0].version).toBe(1);
      expect(revisions[0].taskId).toBe('task-1');
    });

    it('throws TaskAlreadyExistsError when initializing existing task_id', () => {
      engine.initState({
        task_id: 'duplicate-task',
        goal: 'First initialization',
      });

      expect(() =>
        engine.initState({
          task_id: 'duplicate-task',
          goal: 'Second initialization',
        }),
      ).toThrow(TaskAlreadyExistsError);
    });

    it('throws StateValidationError on invalid state input', () => {
      expect(() =>
        engine.initState({
          task_id: '',
          goal: '',
        }),
      ).toThrow(StateValidationError);
    });
  });

  describe('getState / getStateRequired', () => {
    it('returns null for non-existent task in getState', () => {
      const state = engine.getState('non-existent');
      expect(state).toBeNull();
    });

    it('throws StateNotFoundError for non-existent task in getStateRequired', () => {
      expect(() => engine.getStateRequired('non-existent')).toThrow(StateNotFoundError);
    });

    it('retrieves saved state matching parsed schema', () => {
      engine.initState({
        task_id: 'task-read',
        goal: 'Read task state',
        status: 'pending',
        facts: {
          architecture_notes: ['Note 1'],
          key_symbols: ['SymA'],
        },
      });

      const retrieved = engine.getStateRequired('task-read');
      expect(retrieved.taskId).toBe('task-read');
      expect(retrieved.status).toBe('pending');
      expect(retrieved.state.facts.architecture_notes).toEqual(['Note 1']);
      expect(retrieved.state.facts.key_symbols).toEqual(['SymA']);
    });
  });

  describe('patchState (RFC 7396)', () => {
    beforeEach(() => {
      engine.initState({
        task_id: 'task-patch',
        goal: 'Initial Goal',
        status: 'in_progress',
        plan: {
          steps: [
            { id: 's1', title: 'Step 1', status: 'pending' },
            { id: 's2', title: 'Step 2', status: 'pending' },
          ],
          active_step_id: 's1',
        },
        facts: {
          architecture_notes: ['Architecture Note 1'],
          key_symbols: ['StateEngine'],
        },
        working_context: {
          modified_files: ['src/state/engine.ts'],
          diff_summary: 'Created engine',
          test_targets: ['tests/state/engine.test.ts'],
        },
        blockers_and_dead_ends: {
          last_error: 'Test error',
          dead_ends: ['Dead end approach'],
        },
        next_action: 'Write tests',
      });
    });

    it('atomically applies partial patch, increments version, and records revision', () => {
      const updated = engine.patchState('task-patch', {
        plan: {
          active_step_id: 's2',
          steps: [
            { id: 's1', title: 'Step 1', status: 'completed' },
            { id: 's2', title: 'Step 2', status: 'in_progress' },
          ],
        },
        working_context: {
          diff_summary: 'Updated steps and diff',
        },
        next_action: 'Complete step 2',
      });

      expect(updated.version).toBe(2);
      expect(updated.state.plan.active_step_id).toBe('s2');
      expect(updated.state.plan.steps[0].status).toBe('completed');
      expect(updated.state.working_context.diff_summary).toBe('Updated steps and diff');
      // Preserved fields
      expect(updated.state.working_context.modified_files).toEqual(['src/state/engine.ts']);
      expect(updated.state.working_context.test_targets).toEqual(['tests/state/engine.test.ts']);
      expect(updated.state.facts.key_symbols).toEqual(['StateEngine']);
      expect(updated.state.next_action).toBe('Complete step 2');

      // Check revision log
      const revisions = engine.getRevisions('task-patch');
      expect(revisions.length).toBe(2);
      expect(revisions[1].version).toBe(2);
    });

    it('deletes nullable fields when patched with null', () => {
      const updated = engine.patchState('task-patch', {
        blockers_and_dead_ends: {
          last_error: null,
        },
        next_action: null,
      });

      expect(updated.version).toBe(2);
      expect(updated.state.blockers_and_dead_ends.last_error).toBeNull();
      expect(updated.state.blockers_and_dead_ends.dead_ends).toEqual(['Dead end approach']);
      expect(updated.state.next_action).toBeNull();
    });

    it('updates top-level goal and status columns in SQLite table', () => {
      engine.patchState('task-patch', {
        goal: 'Updated Goal Title',
        status: 'completed',
      });

      const raw = db
        .prepare('SELECT goal, status FROM agent_states WHERE task_id = ?')
        .get('task-patch') as { goal: string; status: string };

      expect(raw.goal).toBe('Updated Goal Title');
      expect(raw.status).toBe('completed');
    });

    it('prevents tampering with immutable task_id in patch', () => {
      const updated = engine.patchState('task-patch', {
        task_id: 'hacked-task-id',
        goal: 'Keep original taskId',
      });

      expect(updated.taskId).toBe('task-patch');
      expect(updated.state.task_id).toBe('task-patch');
    });

    it('rejects invalid patch atomically without altering stored state or version', () => {
      const beforeState = engine.getStateRequired('task-patch');

      expect(() =>
        engine.patchState('task-patch', {
          status: 'invalid_status_value',
        }),
      ).toThrow(StateValidationError);

      const afterState = engine.getStateRequired('task-patch');
      expect(afterState.version).toBe(beforeState.version);
      expect(afterState.status).toBe(beforeState.status);

      const revisions = engine.getRevisions('task-patch');
      expect(revisions.length).toBe(1);
    });

    it('throws StateNotFoundError when patching non-existent task', () => {
      expect(() =>
        engine.patchState('missing-task', {
          status: 'completed',
        }),
      ).toThrow(StateNotFoundError);
    });
  });

  describe('checkpoints', () => {
    beforeEach(() => {
      engine.initState({
        task_id: 'task-cp',
        goal: 'Test Checkpoints',
        status: 'in_progress',
        facts: { architecture_notes: ['Initial note'], key_symbols: [] },
      });
    });

    it('creates and retrieves a named checkpoint', () => {
      const cp = engine.createCheckpoint('task-cp', 'v1-checkpoint');
      expect(cp.taskId).toBe('task-cp');
      expect(cp.label).toBe('v1-checkpoint');
      expect(cp.state.goal).toBe('Test Checkpoints');

      const retrieved = engine.getCheckpoint('task-cp', 'v1-checkpoint');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.label).toBe('v1-checkpoint');
    });

    it('lists all checkpoints for a task', () => {
      engine.createCheckpoint('task-cp', 'cp-1');
      engine.patchState('task-cp', { goal: 'Goal 2' });
      engine.createCheckpoint('task-cp', 'cp-2');

      const list = engine.listCheckpoints('task-cp');
      expect(list.length).toBe(2);
      expect(list[0].label).toBe('cp-1');
      expect(list[1].label).toBe('cp-2');
    });

    it('rolls back state to a checkpoint and logs rollback revision', () => {
      engine.createCheckpoint('task-cp', 'before-mutation');

      // Make mutations
      engine.patchState('task-cp', {
        goal: 'Mutated Goal',
        status: 'failed',
        facts: { architecture_notes: ['Mutated note'] },
      });
      engine.patchState('task-cp', {
        next_action: 'Recovery attempt',
      });

      const mutated = engine.getStateRequired('task-cp');
      expect(mutated.version).toBe(3);
      expect(mutated.goal).toBe('Mutated Goal');

      // Rollback
      const rolledBack = engine.rollbackToCheckpoint('task-cp', 'before-mutation');
      expect(rolledBack.version).toBe(4);
      expect(rolledBack.goal).toBe('Test Checkpoints');
      expect(rolledBack.status).toBe('in_progress');
      expect(rolledBack.state.facts.architecture_notes).toEqual(['Initial note']);

      // Check revision history
      const revs = engine.getRevisions('task-cp');
      expect(revs.length).toBe(4);
      expect(revs[3].version).toBe(4);
    });

    it('throws CheckpointNotFoundError when rolling back to non-existent checkpoint', () => {
      expect(() => engine.rollbackToCheckpoint('task-cp', 'ghost-checkpoint')).toThrow(
        CheckpointNotFoundError,
      );
    });
  });

  describe('revisions & rollbackToRevision', () => {
    beforeEach(() => {
      engine.initState({
        task_id: 'task-rev',
        goal: 'Version 1 Goal',
        status: 'in_progress',
        facts: { architecture_notes: ['v1 note'], key_symbols: [] },
      });

      engine.patchState('task-rev', {
        goal: 'Version 2 Goal',
        facts: { architecture_notes: ['v1 note', 'v2 note'] },
      });

      engine.patchState('task-rev', {
        goal: 'Version 3 Goal',
        status: 'completed',
      });
    });

    it('gets all revisions in order', () => {
      const revs = engine.getRevisions('task-rev');
      expect(revs.length).toBe(3);
      expect(revs[0].version).toBe(1);
      expect(revs[1].version).toBe(2);
      expect(revs[2].version).toBe(3);
    });

    it('rolls back to specific historical revision', () => {
      const stateBefore = engine.getStateRequired('task-rev');
      expect(stateBefore.version).toBe(3);
      expect(stateBefore.goal).toBe('Version 3 Goal');

      // Rollback to version 2
      const restored = engine.rollbackToRevision('task-rev', 2);
      expect(restored.version).toBe(4);
      expect(restored.goal).toBe('Version 2 Goal');
      expect(restored.status).toBe('in_progress');
      expect(restored.state.facts.architecture_notes).toEqual(['v1 note', 'v2 note']);

      // Rollback to version 1
      const restoredV1 = engine.rollbackToRevision('task-rev', 1);
      expect(restoredV1.version).toBe(5);
      expect(restoredV1.goal).toBe('Version 1 Goal');
      expect(restoredV1.state.facts.architecture_notes).toEqual(['v1 note']);
    });

    it('throws RevisionNotFoundError when version is invalid', () => {
      expect(() => engine.rollbackToRevision('task-rev', 0)).toThrow(RevisionNotFoundError);
      expect(() => engine.rollbackToRevision('task-rev', 99)).toThrow(RevisionNotFoundError);
    });
  });

  describe('listStates and filtering', () => {
    beforeEach(() => {
      engine.initState({ task_id: 't-1', goal: 'G1', status: 'in_progress' });
      engine.initState({ task_id: 't-2', goal: 'G2', status: 'completed' });
      engine.initState({ task_id: 't-3', goal: 'G3', status: 'in_progress' });
    });

    it('lists all states', () => {
      const all = engine.listStates();
      expect(all.length).toBe(3);
    });

    it('filters states by status', () => {
      const inProgress = engine.listStates({ status: 'in_progress' });
      expect(inProgress.length).toBe(2);
      expect(inProgress.every((s) => s.status === 'in_progress')).toBe(true);

      const completed = engine.listStates({ status: 'completed' });
      expect(completed.length).toBe(1);
      expect(completed[0].taskId).toBe('t-2');
    });

    it('supports limit and offset pagination', () => {
      const paged = engine.listStates({ limit: 2, offset: 0 });
      expect(paged.length).toBe(2);

      const offsetPaged = engine.listStates({ limit: 2, offset: 2 });
      expect(offsetPaged.length).toBe(1);
    });
  });

  describe('deleteState', () => {
    it('deletes state, revisions, and checkpoints', () => {
      engine.initState({ task_id: 'to-delete', goal: 'Delete Me' });
      engine.patchState('to-delete', { goal: 'Delete Me v2' });
      engine.createCheckpoint('to-delete', 'cp-del');

      expect(engine.getState('to-delete')).not.toBeNull();
      expect(engine.getRevisions('to-delete').length).toBe(2);
      expect(engine.listCheckpoints('to-delete').length).toBe(1);

      const deleted = engine.deleteState('to-delete');
      expect(deleted).toBe(true);

      expect(engine.getState('to-delete')).toBeNull();
      expect(engine.getRevisions('to-delete').length).toBe(0);
      expect(engine.listCheckpoints('to-delete').length).toBe(0);
    });

    it('returns false when deleting non-existent state', () => {
      expect(engine.deleteState('missing')).toBe(false);
    });
  });

  describe('file-backed database persistence', () => {
    it('persists states, revisions, and checkpoints across separate connections', () => {
      const tmpDir = createTmpDir('trace-mcp-state-');
      const dbPath = path.join(tmpDir, 'state-test.db');

      const db1 = initializeDatabase(dbPath);
      const engine1 = new StateEngine(db1);

      engine1.initState({
        task_id: 'persisted-task',
        goal: 'Persist across restarts',
        status: 'in_progress',
      });
      engine1.patchState('persisted-task', {
        facts: { architecture_notes: ['Saved to disk'], key_symbols: [] },
      });
      engine1.createCheckpoint('persisted-task', 'disk-cp');
      db1.close();

      // Open new connection
      const db2 = initializeDatabase(dbPath);
      const engine2 = new StateEngine(db2);

      const loaded = engine2.getStateRequired('persisted-task');
      expect(loaded.version).toBe(2);
      expect(loaded.state.facts.architecture_notes).toEqual(['Saved to disk']);

      const revs = engine2.getRevisions('persisted-task');
      expect(revs.length).toBe(2);

      const cp = engine2.getCheckpoint('persisted-task', 'disk-cp');
      expect(cp).not.toBeNull();
      expect(cp!.state.facts.architecture_notes).toEqual(['Saved to disk']);

      db2.close();
      removeTmpDir(tmpDir);
    });
  });
});
