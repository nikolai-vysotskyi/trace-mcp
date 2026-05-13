import { describe, expect, it, vi } from 'vitest';
import { TaskDag } from '../task.js';
import {
  createResolveEdgesTask,
  RESOLVE_EDGES_TASK_NAME,
  type ResolveEdgesTaskInput,
} from '../tasks/resolve-edges-task.js';

/**
 * The `resolve-edges` Task is an adapter — running it should produce the
 * same observable side-effect as calling the host pipeline's
 * `resolveAllEdges()` directly. We verify that by stubbing the closure
 * and asserting both call count and error propagation.
 */
describe('createResolveEdgesTask', () => {
  it('produces a Task with the canonical name', () => {
    const task = createResolveEdgesTask();
    expect(task.name).toBe(RESOLVE_EDGES_TASK_NAME);
    expect(task.name).toBe('resolve-edges');
  });

  it('delegates to the runResolveAllEdges closure exactly once per invocation', async () => {
    const spy = vi.fn(async () => undefined);
    const task = createResolveEdgesTask();

    await task.run({ runResolveAllEdges: spy });
    expect(spy).toHaveBeenCalledTimes(1);

    await task.run({ runResolveAllEdges: spy });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('matches the observable side-effect of calling the underlying method directly', async () => {
    // Side by side: invoke the closure directly, then invoke it via the Task.
    // The spy must record the same number of calls.
    const spy = vi.fn(async () => undefined);
    const direct = async () => spy();
    const task = createResolveEdgesTask();

    await direct();
    expect(spy).toHaveBeenCalledTimes(1);

    await task.run({ runResolveAllEdges: direct });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('runs through a TaskDag the same way as the standalone Task', async () => {
    const spy = vi.fn(async () => undefined);
    const dag = new TaskDag();
    dag.register(createResolveEdgesTask());

    const input: ResolveEdgesTaskInput = { runResolveAllEdges: spy };
    await dag.run<ResolveEdgesTaskInput, void>(RESOLVE_EDGES_TASK_NAME, input);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from the underlying method', async () => {
    const task = createResolveEdgesTask();
    const failing = async () => {
      throw new Error('edge resolver exploded');
    };

    await expect(task.run({ runResolveAllEdges: failing })).rejects.toThrow(/exploded/);
  });

  it('honours AbortSignal at the dag dispatch boundary', async () => {
    const spy = vi.fn(async () => undefined);
    const dag = new TaskDag();
    dag.register(createResolveEdgesTask());

    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await expect(
      dag.run<ResolveEdgesTaskInput, void>(
        RESOLVE_EDGES_TASK_NAME,
        { runResolveAllEdges: spy },
        ac.signal,
      ),
    ).rejects.toThrow(/stop/);
    expect(spy).not.toHaveBeenCalled();
  });
});
