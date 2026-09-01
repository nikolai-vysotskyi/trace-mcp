import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StateEngine } from '../state-engine.js';

describe('StateEngine SQLite Storage and Lifecycle', () => {
  let engine: StateEngine;

  beforeEach(() => {
    // Use an in-memory SQLite DB for isolated tests
    const memDb = new Database(':memory:');
    engine = new StateEngine(memDb);
  });

  it('initializes state and persists to database', () => {
    const state = engine.initState('TRA-596', 'Build State Engine', [
      'Write SQLite schema',
      'Implement MCP tools',
    ]);

    expect(state.task_id).toBe('TRA-596');
    expect(state.goal).toBe('Build State Engine');
    expect(state.plan.steps.length).toBe(2);
    expect(state.plan.steps[0]?.status).toBe('in_progress');
    expect(state.plan.steps[1]?.status).toBe('pending');
    expect(state.plan.active_step_id).toBe('step_1');

    const fetched = engine.getState('TRA-596');
    expect(fetched).not.toBeNull();
    expect(fetched?.version).toBe(1);
    expect(fetched?.state.task_id).toBe('TRA-596');
  });

  it('applies JSON Merge Patch and increments revision version', () => {
    engine.initState('TRA-596', 'Build State Engine', ['Step 1', 'Step 2']);

    const patchResult = engine.patchState('TRA-596', {
      plan: {
        steps: [
          { id: 'step_1', title: 'Step 1', status: 'completed' },
          { id: 'step_2', title: 'Step 2', status: 'in_progress' },
        ],
        active_step_id: 'step_2',
      },
      facts: {
        architecture_notes: ['RFC 7396 merge patch verified'],
      },
      next_action: 'Step 2 in progress',
    });

    expect(patchResult.success).toBe(true);
    expect(patchResult.version).toBe(2);
    expect(patchResult.active_step_id).toBe('step_2');
    expect(patchResult.state.plan.steps[0]?.status).toBe('completed');
    expect(patchResult.state.facts.architecture_notes).toEqual(['RFC 7396 merge patch verified']);

    const fetched = engine.getState('TRA-596');
    expect(fetched?.version).toBe(2);
    expect(fetched?.state.plan.steps[0]?.status).toBe('completed');
  });

  it('rejects patch when validation fails and leaves previous state unchanged', () => {
    engine.initState('TRA-596', 'Build State Engine');

    expect(() => {
      engine.patchState('TRA-596', {
        status: 'invalid_status_value',
      });
    }).toThrow(/Invalid state after applying patch/);

    const fetched = engine.getState('TRA-596');
    expect(fetched?.version).toBe(1);
    expect(fetched?.state.status).toBe('in_progress');
  });

  it('supports creating checkpoints and rolling back', () => {
    engine.initState('TRA-596', 'Build State Engine', ['Step 1']);

    engine.patchState('TRA-596', {
      working_context: { modified_files: ['file1.ts'] },
    });

    const cp = engine.createCheckpoint('TRA-596', 'before-risky-refactor');
    expect(cp.label).toBe('before-risky-refactor');
    expect(cp.version).toBe(2);

    // Apply a risky change
    engine.patchState('TRA-596', {
      status: 'failed',
      working_context: { modified_files: ['file1.ts', 'broken.ts'] },
      blockers_and_dead_ends: { last_error: 'Syntax error in broken.ts' },
    });

    const broken = engine.getState('TRA-596');
    expect(broken?.version).toBe(3);
    expect(broken?.state.status).toBe('failed');

    // Rollback
    const rollback = engine.rollbackToCheckpoint('TRA-596', 'before-risky-refactor');
    expect(rollback.success).toBe(true);
    expect(rollback.version).toBe(4);
    expect(rollback.state.status).toBe('in_progress');
    expect(rollback.state.working_context.modified_files).toEqual(['file1.ts']);
  });

  it('records dead ends using addDeadEnd', () => {
    engine.initState('TRA-596', 'Build State Engine');

    const res = engine.addDeadEnd('TRA-596', 'Out of memory during bulk parse', 'Pure in-memory map');
    expect(res.success).toBe(true);
    expect(res.version).toBe(2);
    expect(res.state.blockers_and_dead_ends.dead_ends?.length).toBe(1);
    expect(res.state.blockers_and_dead_ends.dead_ends?.[0]?.approach).toBe('Pure in-memory map');
    expect(res.state.blockers_and_dead_ends.dead_ends?.[0]?.reason).toBe('Out of memory during bulk parse');
  });

  it('notifies listeners on state changes', () => {
    const listener = vi.fn();
    const unsub = engine.onStateChange(listener);

    engine.initState('TRA-596', 'Build State Engine');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'TRA-596',
        version: 1,
      }),
    );

    engine.patchState('TRA-596', { status: 'completed' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        taskId: 'TRA-596',
        version: 2,
      }),
    );

    unsub();
    engine.patchState('TRA-596', { status: 'in_progress' });
    expect(listener).toHaveBeenCalledTimes(2); // not called after unsub
  });

  it('lists states and deletes states', () => {
    engine.initState('TASK-1', 'Goal 1');
    engine.initState('TASK-2', 'Goal 2');

    const list = engine.listStates();
    expect(list.length).toBe(2);

    const deleted = engine.deleteState('TASK-1');
    expect(deleted).toBe(true);
    expect(engine.getState('TASK-1')).toBeNull();
    expect(engine.listStates().length).toBe(1);
  });
});
