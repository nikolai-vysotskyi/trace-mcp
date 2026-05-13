import { describe, expect, it, vi } from 'vitest';
import type { EnvIndexer } from '../../indexer/env-indexer.js';
import { TaskDag } from '../task.js';
import {
  createIndexEnvTask,
  INDEX_ENV_TASK_NAME,
  type IndexEnvTaskInput,
} from '../tasks/index-env-task.js';

/**
 * The Task is an adapter — running it should produce the same observable
 * side-effect as calling `envIndexer.indexEnvFiles(force)` directly. We
 * verify that by stubbing the `EnvIndexer` and asserting both the call count
 * and the `force` argument forwarding.
 */
function stubEnvIndexer(): { indexer: EnvIndexer; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async (_force: boolean) => undefined);
  const indexer = { indexEnvFiles: spy } as unknown as EnvIndexer;
  return { indexer, spy };
}

describe('createIndexEnvTask', () => {
  it('produces a Task with the canonical name', () => {
    const task = createIndexEnvTask();
    expect(task.name).toBe(INDEX_ENV_TASK_NAME);
    expect(task.name).toBe('index-env');
  });

  it('delegates to envIndexer.indexEnvFiles with the forwarded force flag', async () => {
    const { indexer, spy } = stubEnvIndexer();
    const task = createIndexEnvTask();

    await task.run({ envIndexer: indexer, force: false });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(false);

    await task.run({ envIndexer: indexer, force: true });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(true);
  });

  it('matches the observable side-effect of calling the original method', async () => {
    // Side by side: call `EnvIndexer.indexEnvFiles` directly, then call the
    // Task. Both should hit the same spy with the same argument shape and the
    // same number of times.
    const { indexer, spy } = stubEnvIndexer();

    await indexer.indexEnvFiles(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenNthCalledWith(1, false);

    const task = createIndexEnvTask();
    await task.run({ envIndexer: indexer, force: false });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(2, false);
  });

  it('runs through a TaskDag the same way as the standalone Task', async () => {
    const { indexer, spy } = stubEnvIndexer();
    const dag = new TaskDag();
    dag.register(createIndexEnvTask());

    const input: IndexEnvTaskInput = { envIndexer: indexer, force: true };
    await dag.run<IndexEnvTaskInput, void>(INDEX_ENV_TASK_NAME, input);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(true);
  });

  it('propagates errors from the underlying indexer', async () => {
    const indexer = {
      indexEnvFiles: vi.fn(async () => {
        throw new Error('disk full');
      }),
    } as unknown as EnvIndexer;
    const task = createIndexEnvTask();

    await expect(task.run({ envIndexer: indexer, force: false })).rejects.toThrow(/disk full/);
  });
});
