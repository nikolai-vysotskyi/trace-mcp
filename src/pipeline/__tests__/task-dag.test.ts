import { describe, expect, it, vi } from 'vitest';
import { TaskDag, defineTask } from '../task.js';

describe('TaskDag', () => {
  it('registers a task and runs it', async () => {
    const dag = new TaskDag();
    dag.register(
      defineTask<number, number>({
        name: 'double',
        run: (n) => n * 2,
      }),
    );

    await expect(dag.run<number, number>('double', 3)).resolves.toBe(6);
    expect(dag.list()).toEqual(['double']);
  });

  it('throws on duplicate registration', () => {
    const dag = new TaskDag();
    const t = defineTask<number, number>({ name: 'noop', run: (n) => n });
    dag.register(t);
    expect(() => dag.register(t)).toThrow(/already registered/);
  });

  it('throws when running an unknown task', async () => {
    const dag = new TaskDag();
    await expect(dag.run('missing', 1)).rejects.toThrow(/not registered/);
  });

  it('caches results when a key function is provided', async () => {
    const dag = new TaskDag();
    const run = vi.fn(async (n: number) => n + 1);
    dag.register(
      defineTask<number, number>({
        name: 'inc',
        key: (n) => String(n),
        run,
      }),
    );

    expect(await dag.run<number, number>('inc', 5)).toBe(6);
    expect(await dag.run<number, number>('inc', 5)).toBe(6);
    expect(await dag.run<number, number>('inc', 5)).toBe(6);
    expect(run).toHaveBeenCalledTimes(1);
    expect(dag.cacheSize).toBe(1);

    expect(await dag.run<number, number>('inc', 6)).toBe(7);
    expect(run).toHaveBeenCalledTimes(2);
    expect(dag.cacheSize).toBe(2);
  });

  it('does NOT cache when no key function is provided', async () => {
    const dag = new TaskDag();
    const run = vi.fn(async (n: number) => n + 1);
    dag.register(defineTask<number, number>({ name: 'inc', run }));

    await dag.run<number, number>('inc', 1);
    await dag.run<number, number>('inc', 1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(dag.cacheSize).toBe(0);
  });

  it('clearCache invalidates all entries', async () => {
    const dag = new TaskDag();
    const run = vi.fn(async (n: number) => n + 1);
    dag.register(defineTask<number, number>({ name: 'inc', key: (n) => String(n), run }));

    await dag.run<number, number>('inc', 1);
    await dag.run<number, number>('inc', 2);
    expect(dag.cacheSize).toBe(2);

    dag.clearCache();
    expect(dag.cacheSize).toBe(0);

    await dag.run<number, number>('inc', 1);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('invalidate removes a single cache entry', async () => {
    const dag = new TaskDag();
    const run = vi.fn(async (n: number) => n + 1);
    dag.register(defineTask<number, number>({ name: 'inc', key: (n) => String(n), run }));

    await dag.run<number, number>('inc', 1);
    await dag.run<number, number>('inc', 2);
    expect(dag.cacheSize).toBe(2);

    dag.invalidate('inc', 1);
    expect(dag.cacheSize).toBe(1);

    await dag.run<number, number>('inc', 1);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('composes tasks in order, threading output to input', async () => {
    const dag = new TaskDag();
    dag.register(defineTask<number, number>({ name: 'plus1', run: (n) => n + 1 }));
    dag.register(defineTask<number, number>({ name: 'times3', run: (n) => n * 3 }));
    dag.register(defineTask<number, string>({ name: 'stringify', run: (n) => `value=${n}` }));

    const result = await dag.compose<number, string>(['plus1', 'times3', 'stringify'], 4);

    expect(result.output).toBe('value=15');
    expect(result.steps.map((s) => s.name)).toEqual(['plus1', 'times3', 'stringify']);
    for (const step of result.steps) {
      expect(step.cache_hit).toBe(false);
      expect(typeof step.duration_ms).toBe('number');
      expect(step.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('compose reports cache hits on subsequent runs', async () => {
    const dag = new TaskDag();
    const run = vi.fn(async (n: number) => n + 1);
    dag.register(defineTask<number, number>({ name: 'inc', key: (n) => String(n), run }));

    const first = await dag.compose<number, number>(['inc'], 1);
    expect(first.steps[0].cache_hit).toBe(false);

    const second = await dag.compose<number, number>(['inc'], 1);
    expect(second.steps[0].cache_hit).toBe(true);
    expect(second.output).toBe(2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('compose with empty list throws', async () => {
    const dag = new TaskDag();
    await expect(dag.compose([], 0)).rejects.toThrow(/at least one task/);
  });

  it('honours AbortSignal before running a task', async () => {
    const dag = new TaskDag();
    const run = vi.fn(async (n: number) => n);
    dag.register(defineTask<number, number>({ name: 'identity', run }));

    const controller = new AbortController();
    controller.abort(new Error('cancelled-by-test'));

    await expect(dag.run('identity', 1, controller.signal)).rejects.toThrow(/cancelled-by-test/);
    expect(run).not.toHaveBeenCalled();
  });

  it('compose aborts mid-chain on signal', async () => {
    const dag = new TaskDag();
    const runA = vi.fn(async (n: number) => n + 1);
    const runB = vi.fn(async (n: number) => n + 1);
    dag.register(defineTask<number, number>({ name: 'a', run: runA }));
    dag.register(defineTask<number, number>({ name: 'b', run: runB }));

    const controller = new AbortController();
    // Abort after `a` finishes but before `b` starts.
    runA.mockImplementation(async (n: number) => {
      controller.abort(new Error('mid-chain'));
      return n + 1;
    });

    await expect(dag.compose(['a', 'b'], 0, controller.signal)).rejects.toThrow(/mid-chain/);
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).not.toHaveBeenCalled();
  });

  it('forwards the AbortSignal into Task.run', async () => {
    const dag = new TaskDag();
    let received: AbortSignal | undefined;
    dag.register(
      defineTask<number, number>({
        name: 'capture',
        run: (n, signal) => {
          received = signal;
          return n;
        },
      }),
    );

    const controller = new AbortController();
    await dag.run('capture', 1, controller.signal);
    expect(received).toBe(controller.signal);
  });

  it('has() reports registration status', () => {
    const dag = new TaskDag();
    expect(dag.has('x')).toBe(false);
    dag.register(defineTask<number, number>({ name: 'x', run: (n) => n }));
    expect(dag.has('x')).toBe(true);
  });
});
