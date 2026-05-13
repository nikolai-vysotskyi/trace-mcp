import { describe, expect, it, vi } from 'vitest';
import { TaskDag } from '../task.js';
import {
  createGraphSnapshotsTask,
  GRAPH_SNAPSHOTS_TASK_NAME,
  type GraphSnapshotsTaskInput,
} from '../tasks/graph-snapshots-task.js';

/**
 * The `graph-snapshots` Task is an adapter — running it should produce
 * the same observable effect as calling `captureGraphSnapshots(store,
 * rootPath)` directly. We verify by stubbing the closure.
 */
describe('createGraphSnapshotsTask', () => {
  it('produces a Task with the canonical name', () => {
    const task = createGraphSnapshotsTask();
    expect(task.name).toBe(GRAPH_SNAPSHOTS_TASK_NAME);
    expect(task.name).toBe('graph-snapshots');
  });

  it('delegates to the captureSnapshots closure exactly once per invocation', async () => {
    const spy = vi.fn(() => undefined);
    const task = createGraphSnapshotsTask();

    await task.run({ captureSnapshots: spy });
    expect(spy).toHaveBeenCalledTimes(1);

    await task.run({ captureSnapshots: spy });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('matches the observable side-effect of calling the underlying function directly', async () => {
    const spy = vi.fn(() => undefined);
    const direct = () => spy();
    const task = createGraphSnapshotsTask();

    direct();
    expect(spy).toHaveBeenCalledTimes(1);

    await task.run({ captureSnapshots: direct });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('runs through a TaskDag the same way as the standalone Task', async () => {
    const spy = vi.fn(() => undefined);
    const dag = new TaskDag();
    dag.register(createGraphSnapshotsTask());

    const input: GraphSnapshotsTaskInput = { captureSnapshots: spy };
    await dag.run<GraphSnapshotsTaskInput, void>(GRAPH_SNAPSHOTS_TASK_NAME, input);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('propagates synchronous errors from the underlying function', async () => {
    const task = createGraphSnapshotsTask();
    const failing = () => {
      throw new Error('history table missing');
    };

    await expect(task.run({ captureSnapshots: failing })).rejects.toThrow(/history table missing/);
  });
});
