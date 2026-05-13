/**
 * Composable Task DAG abstraction for the indexing pipeline.
 *
 * Vertical slice for plan-cognee-P02. The goal is NOT to rip out the existing
 * imperative `IndexingPipeline.runPipeline` orchestration in
 * `src/indexer/pipeline.ts`. Instead, this module introduces a small Task /
 * TaskDag surface so individual pipeline passes can be expressed as
 * composable, idempotency-keyed units. One existing pass (.env indexing) is
 * migrated as proof — see `src/pipeline/tasks/index-env-task.ts`.
 *
 * Why a separate abstraction rather than editing the pipeline in place?
 *
 *  - Plugins cannot currently contribute passes; the pipeline is hand-wired.
 *  - There is no per-pass cache. A re-run with no relevant changes still walks
 *    every phase. The `key` hook here is the foundation for that cache.
 *  - The existing pipeline is large and load-bearing. Migrating phases one at a
 *    time, behind an adapter that delegates to the existing function, keeps
 *    behaviour stable while we grow the abstraction.
 *
 * The cache is an in-memory `Map` in this slice. A persisted variant (likely a
 * `pass_cache` SQLite table keyed by `(pass_name, key, plugin_version)`) is a
 * follow-up — see plan §"Per-pass cache".
 */

/** A Task is a named, optionally idempotent step that transforms `I` into `O`. */
export interface Task<I, O> {
  /** Stable identifier used in logs, telemetry, and the dag registry. */
  readonly name: string;
  /**
   * Optional pure-function key. When provided, results are memoised by key in
   * the in-memory cache attached to the `TaskDag` instance. Tasks that depend
   * on mutable external state (the DB, filesystem) should generally omit `key`
   * unless callers can guarantee the inputs uniquely describe the side-effect.
   */
  readonly key?: (input: I) => string;
  /**
   * Execute the task. The `AbortSignal` is forwarded from `TaskDag.run` and
   * MUST be checked at any obvious yield point. Long-running tasks should
   * throw `new Error('aborted')` (or similar) when `signal.aborted` flips.
   */
  run(input: I, signal?: AbortSignal): Promise<O>;
}

/** Summary entry recorded for every step inside `run` / `compose`. */
export interface TaskStepSummary {
  name: string;
  duration_ms: number;
  cache_hit: boolean;
}

/** Aggregate summary returned from `compose`. */
export interface TaskComposeSummary<O> {
  output: O;
  steps: TaskStepSummary[];
}

/**
 * The TaskDag is a tiny registry + sequential composer.
 *
 * - `register(task)` adds a task to the registry. Tasks must have unique
 *   names; re-registering the same name throws.
 * - `run(name, input, signal?)` invokes a single task with idempotency.
 * - `compose(names, input, signal?)` runs tasks in order, feeding each
 *   task's output as the next task's input. Aborts the chain on the first
 *   error or when the signal fires.
 *
 * The cache is intentionally `Map<string, unknown>` rather than a typed,
 * per-task cache: we lose a little type safety in exchange for a single,
 * inspectable structure that's easy to clear in tests.
 */
export class TaskDag {
  private readonly tasks = new Map<string, Task<unknown, unknown>>();
  private readonly cache = new Map<string, unknown>();

  /** Register a task. Throws on duplicate names — silently shadowing is worse. */
  register<I, O>(task: Task<I, O>): void {
    if (this.tasks.has(task.name)) {
      throw new Error(`TaskDag: task "${task.name}" already registered`);
    }
    this.tasks.set(task.name, task as Task<unknown, unknown>);
  }

  /** True when a task with this name has been registered. */
  has(name: string): boolean {
    return this.tasks.has(name);
  }

  /** Retrieve a registered task, throwing on miss. */
  get<I, O>(name: string): Task<I, O> {
    const task = this.tasks.get(name);
    if (!task) throw new Error(`TaskDag: task "${name}" not registered`);
    return task as Task<I, O>;
  }

  /**
   * Run a single registered task. If the task supplies a `key` function and
   * the resulting cache key is already populated, the cached result is
   * returned without invoking `run` again.
   *
   * Cancellation: if `signal.aborted` is true before invocation, the task is
   * not started and an `AbortError`-style error is thrown. Tasks already in
   * flight are responsible for honouring the signal themselves.
   */
  async run<I, O>(name: string, input: I, signal?: AbortSignal): Promise<O> {
    const task = this.get<I, O>(name);
    this.throwIfAborted(signal);

    const cacheKey = this.computeCacheKey(task, input);
    if (cacheKey !== undefined && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) as O;
    }

    const output = await task.run(input, signal);
    if (cacheKey !== undefined) this.cache.set(cacheKey, output);
    return output;
  }

  /**
   * Run a sequence of registered tasks. The output of step N becomes the input
   * of step N+1. Returns the final output plus per-step timings and
   * cache-hit info — useful for telemetry without changing the return type
   * of `run`.
   */
  async compose<I, O>(
    names: readonly string[],
    input: I,
    signal?: AbortSignal,
  ): Promise<TaskComposeSummary<O>> {
    if (names.length === 0) {
      throw new Error('TaskDag.compose: at least one task name is required');
    }
    const steps: TaskStepSummary[] = [];
    let current: unknown = input;

    for (const name of names) {
      this.throwIfAborted(signal);
      const task = this.get<unknown, unknown>(name);
      const cacheKey = this.computeCacheKey(task, current);
      const cacheHit = cacheKey !== undefined && this.cache.has(cacheKey);
      const start = Date.now();

      if (cacheHit) {
        current = this.cache.get(cacheKey!);
      } else {
        current = await task.run(current, signal);
        if (cacheKey !== undefined) this.cache.set(cacheKey, current);
      }

      steps.push({ name, duration_ms: Date.now() - start, cache_hit: cacheHit });
    }

    return { output: current as O, steps };
  }

  /** Clear the idempotency cache. Useful in tests and after schema bumps. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Forget a single cache entry. */
  invalidate(name: string, input: unknown): void {
    const task = this.tasks.get(name);
    if (!task) return;
    const cacheKey = this.computeCacheKey(task, input);
    if (cacheKey !== undefined) this.cache.delete(cacheKey);
  }

  /** Number of cache entries — handy for test assertions. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** Names of registered tasks in registration order. */
  list(): string[] {
    return Array.from(this.tasks.keys());
  }

  private computeCacheKey(task: Task<unknown, unknown>, input: unknown): string | undefined {
    if (!task.key) return undefined;
    return `${task.name}::${task.key(input)}`;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      const reason = signal.reason ?? new Error('aborted');
      throw reason instanceof Error ? reason : new Error(String(reason));
    }
  }
}

/**
 * Convenience helper for constructing a Task without writing a class.
 *
 * ```ts
 * const t = defineTask({
 *   name: 'lowercase',
 *   key: (s) => s,
 *   run: async (s: string) => s.toLowerCase(),
 * });
 * ```
 */
export function defineTask<I, O>(opts: {
  name: string;
  key?: (input: I) => string;
  run: (input: I, signal?: AbortSignal) => Promise<O> | O;
}): Task<I, O> {
  return {
    name: opts.name,
    key: opts.key,
    async run(input: I, signal?: AbortSignal): Promise<O> {
      return await opts.run(input, signal);
    },
  };
}
