/**
 * `index-env` Task — adapter wrapping the existing `EnvIndexer.indexEnvFiles`
 * pass from `src/indexer/env-indexer.ts`.
 *
 * Why this pass was chosen as the first migration target:
 *
 *  - It is the most self-contained pipeline pass we have. The current
 *    invocation site in `IndexingPipeline.indexEnvFiles` (src/indexer/pipeline.ts
 *    around line 697) is three lines: `new EnvIndexer(...).indexEnvFiles(force)`.
 *    There is no surrounding state mutation that would leak across the Task
 *    boundary.
 *  - It has clear inputs (the `EnvIndexer` instance plus a `force` flag) and a
 *    `void` return — exactly the `Task<Input, void>` shape we want to validate
 *    first.
 *  - It is OFF the hot path. Even if the Task wrapper has a regression, the
 *    blast radius is .env handling, not the symbol extractor or edge resolver.
 *  - It already exists as its own class with its own tests — extracting a
 *    Task wrapper does not duplicate the body.
 *
 * The adapter pattern: this Task does NOT reimplement env-file indexing. It
 * just calls `envIndexer.indexEnvFiles(force)`. If you change the behaviour of
 * env indexing, change it in `EnvIndexer`. The Task is a thin shim that lets
 * the indexing pipeline schedule this pass through the same surface as future
 * Tasks.
 *
 * Cancellation: `EnvIndexer.indexEnvFiles` is a single awaited call and does
 * not currently honour an `AbortSignal`. We check the signal before dispatch
 * — that is the most we can do without modifying `EnvIndexer` itself. Once
 * the env indexer grows finer-grained yield points, this Task should forward
 * the signal.
 */
import type { EnvIndexer } from '../../indexer/env-indexer.js';
import { defineTask, type Task } from '../task.js';

/** Inputs passed to the `index-env` Task on every invocation. */
export interface IndexEnvTaskInput {
  /** The env indexer instance owned by the surrounding pipeline. */
  envIndexer: EnvIndexer;
  /** When true, re-process .env files even when their content hash matches. */
  force: boolean;
}

/** Output is `void` — the side-effect is on the store, not the return value. */
export type IndexEnvTaskOutput = void;

/**
 * Stable name re-used by callers wishing to look the task up in a `TaskDag`.
 * Intentionally NOT prefixed with `pipeline.` — Task names are used directly
 * as telemetry labels and should read as English.
 */
export const INDEX_ENV_TASK_NAME = 'index-env';

/**
 * Build the Task instance. Constructed lazily so tests can register a fresh
 * task per `TaskDag`, and so the production wiring can attach plugin-specific
 * `key` functions without forking the implementation.
 *
 * No `key` is supplied by default — .env indexing already has its own
 * content-hash gate inside `EnvIndexer`. Re-running the task is cheap and
 * correct; caching at the Task layer would only help when we know upfront
 * that the file set has not changed, which is the job of a higher-level
 * change-scope key (a follow-up).
 */
export function createIndexEnvTask(): Task<IndexEnvTaskInput, IndexEnvTaskOutput> {
  return defineTask<IndexEnvTaskInput, IndexEnvTaskOutput>({
    name: INDEX_ENV_TASK_NAME,
    run: async ({ envIndexer, force }) => {
      await envIndexer.indexEnvFiles(force);
    },
  });
}
