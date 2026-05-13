import { describe, expect, it, vi } from 'vitest';
import { TaskDag } from '../task.js';
import {
  createLspEnrichmentTask,
  LSP_ENRICHMENT_TASK_NAME,
  type LspEnrichmentTaskInput,
} from '../tasks/lsp-enrichment-task.js';

/**
 * The `lsp-enrichment` Task is an adapter — running it should produce the
 * same observable effect as calling the host pipeline's
 * `runLspEnrichment()` directly. We verify by stubbing the closure.
 */
describe('createLspEnrichmentTask', () => {
  it('produces a Task with the canonical name', () => {
    const task = createLspEnrichmentTask();
    expect(task.name).toBe(LSP_ENRICHMENT_TASK_NAME);
    expect(task.name).toBe('lsp-enrichment');
  });

  it('delegates to the runLspEnrichment closure exactly once per invocation', async () => {
    const spy = vi.fn(async () => undefined);
    const task = createLspEnrichmentTask();

    await task.run({ runLspEnrichment: spy });
    expect(spy).toHaveBeenCalledTimes(1);

    await task.run({ runLspEnrichment: spy });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('matches the observable side-effect of calling the underlying method directly', async () => {
    const spy = vi.fn(async () => undefined);
    const direct = async () => spy();
    const task = createLspEnrichmentTask();

    await direct();
    expect(spy).toHaveBeenCalledTimes(1);

    await task.run({ runLspEnrichment: direct });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('runs through a TaskDag the same way as the standalone Task', async () => {
    const spy = vi.fn(async () => undefined);
    const dag = new TaskDag();
    dag.register(createLspEnrichmentTask());

    const input: LspEnrichmentTaskInput = { runLspEnrichment: spy };
    await dag.run<LspEnrichmentTaskInput, void>(LSP_ENRICHMENT_TASK_NAME, input);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('propagates errors from the underlying method (caller decides whether to swallow them)', async () => {
    // The original runLspEnrichment internalises its own try/catch and never
    // throws. The Task itself is a transparent shim — if a future refactor
    // were to let the error escape, the Task must surface it rather than
    // silently swallow.
    const task = createLspEnrichmentTask();
    const failing = async () => {
      throw new Error('lsp bridge crashed');
    };

    await expect(task.run({ runLspEnrichment: failing })).rejects.toThrow(/bridge crashed/);
  });
});
