import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { StateEngine } from '../state-engine.js';

describe('StateEngine', () => {
  let db: Database.Database;
  let engine: StateEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new StateEngine(db);
  });

  describe('init', () => {
    it('initializes a fresh task state with valid schema', () => {
      const state = engine.init({
        task_id: 'TRA-100',
        goal: 'Implement SKILL.state',
        initial_plan: ['Step 1: Storage', 'Step 2: MCP Tools'],
      });

      expect(state.task_id).toBe('TRA-100');
      expect(state.goal).toBe('Implement SKILL.state');
      expect(state.status).toBe('in_progress');
      expect(state.version).toBe(1);
      expect(state.plan.steps).toHaveLength(2);
      expect(state.plan.steps[0]).toEqual({
        id: 'step_1',
        description: 'Step 1: Storage',
        status: 'in_progress',
      });
      expect(state.plan.steps[1]).toEqual({
        id: 'step_2',
        description: 'Step 2: MCP Tools',
        status: 'pending',
      });
      expect(state.plan.active_step_id).toBe('step_1');
      expect(state.next_action).toBe('Step 1: Storage');
      expect(state.facts.architecture_notes).toEqual([]);
      expect(state.facts.key_symbols).toEqual([]);
      expect(state.working_context.modified_files).toEqual([]);
      expect(state.blockers_and_dead_ends.dead_ends).toEqual([]);
    });

    it('rejects empty task_id or goal', () => {
      expect(() => engine.init({ task_id: '', goal: 'test' })).toThrow();
      expect(() => engine.init({ task_id: 'TRA-1', goal: ' ' })).toThrow();
    });

    it('records initial revision in sqlite', () => {
      engine.init({ task_id: 'TRA-101', goal: 'Initial task' });
      const revs = engine.listRevisions('TRA-101');
      expect(revs).toHaveLength(1);
      expect(revs[0].version).toBe(1);
    });
  });

  describe('patch', () => {
    it('applies RFC 7396 merge patch, bumps version, and records revision', () => {
      engine.init({
        task_id: 'TRA-200',
        goal: 'Patch test',
        initial_plan: ['Step 1', 'Step 2'],
      });

      const patchResult = engine.patch({
        task_id: 'TRA-200',
        patch: {
          plan: {
            active_step_id: 'step_2',
            steps: [
              { id: 'step_1', description: 'Step 1', status: 'completed' },
              { id: 'step_2', description: 'Step 2', status: 'in_progress' },
            ],
          },
          working_context: {
            modified_files: ['src/state/state-engine.ts'],
            diff_summary: 'Added StateEngine class',
          },
          next_action: 'Write tests',
        },
      });

      expect(patchResult.success).toBe(true);
      expect(patchResult.version).toBe(2);
      expect(patchResult.active_step_id).toBe('step_2');
      expect(patchResult.state.plan.steps[0].status).toBe('completed');
      expect(patchResult.state.working_context.modified_files).toEqual([
        'src/state/state-engine.ts',
      ]);
      expect(patchResult.state.working_context.diff_summary).toBe('Added StateEngine class');
      expect(patchResult.state.next_action).toBe('Write tests');

      const savedState = engine.get('TRA-200');
      expect(savedState?.version).toBe(2);

      const revs = engine.listRevisions('TRA-200');
      expect(revs).toHaveLength(2);
      expect(revs[1].version).toBe(2);
    });

    it('throws when patching non-existent task', () => {
      expect(() => engine.patch({ task_id: 'NONEXISTENT', patch: { goal: 'new' } })).toThrow(
        /not found/,
      );
    });

    it('validates schema and rejects invalid status values', () => {
      engine.init({ task_id: 'TRA-201', goal: 'Validation test' });
      expect(() =>
        engine.patch({
          task_id: 'TRA-201',
          patch: { status: 'invalid_status_value' },
        }),
      ).toThrow();
    });
  });

  describe('checkpoint and rollback', () => {
    it('creates named checkpoints and rolls back successfully', () => {
      engine.init({
        task_id: 'TRA-300',
        goal: 'Rollback test',
        initial_plan: ['Step 1'],
      });

      // Version 1 checkpoint
      const chk1 = engine.checkpoint({
        task_id: 'TRA-300',
        label: 'before_major_refactor',
      });
      expect(chk1.success).toBe(true);
      expect(chk1.label).toBe('before_major_refactor');

      // Version 2 patch
      engine.patch({
        task_id: 'TRA-300',
        patch: {
          working_context: {
            modified_files: ['broken_file.ts'],
          },
          status: 'failed',
        },
      });

      const stateBeforeRollback = engine.get('TRA-300');
      expect(stateBeforeRollback?.version).toBe(2);
      expect(stateBeforeRollback?.status).toBe('failed');
      expect(stateBeforeRollback?.working_context.modified_files).toEqual(['broken_file.ts']);

      // Rollback to checkpoint by label
      const rollbackResult = engine.rollback({
        task_id: 'TRA-300',
        checkpoint_id_or_label: 'before_major_refactor',
      });

      expect(rollbackResult.success).toBe(true);
      expect(rollbackResult.rolled_back_to).toBe('before_major_refactor');
      expect(rollbackResult.version).toBe(3);
      expect(rollbackResult.state.status).toBe('in_progress');
      expect(rollbackResult.state.working_context.modified_files).toEqual([]);

      const stateAfterRollback = engine.get('TRA-300');
      expect(stateAfterRollback?.version).toBe(3);
      expect(stateAfterRollback?.working_context.modified_files).toEqual([]);
    });

    it('throws error when checkpoint is not found', () => {
      engine.init({ task_id: 'TRA-301', goal: 'Test' });
      expect(() =>
        engine.rollback({
          task_id: 'TRA-301',
          checkpoint_id_or_label: 'nonexistent_label',
        }),
      ).toThrow(/not found/);
    });
  });

  describe('addDeadEnd', () => {
    it('appends reason to dead_ends and bumps version', () => {
      engine.init({ task_id: 'TRA-400', goal: 'Dead end test' });

      const res1 = engine.addDeadEnd({
        task_id: 'TRA-400',
        reason: 'Attempted regex approach but hit catastrophic backtracking',
      });

      expect(res1.success).toBe(true);
      expect(res1.version).toBe(2);
      expect(res1.dead_ends_count).toBe(1);
      expect(res1.state.blockers_and_dead_ends.dead_ends).toEqual([
        'Attempted regex approach but hit catastrophic backtracking',
      ]);

      const res2 = engine.addDeadEnd({
        task_id: 'TRA-400',
        reason: 'AST parser v1 does not support tsx syntax',
      });

      expect(res2.success).toBe(true);
      expect(res2.version).toBe(3);
      expect(res2.dead_ends_count).toBe(2);
      expect(res2.state.blockers_and_dead_ends.dead_ends).toHaveLength(2);
    });
  });
});
