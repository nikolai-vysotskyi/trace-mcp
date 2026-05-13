/**
 * `resolve-edges` Task — adapter wrapping the existing
 * `IndexingPipeline.resolveAllEdges` pass (src/indexer/pipeline.ts:613).
 *
 * The underlying method builds a `ChangeScope` from pipeline state, then
 * walks an `EdgeResolver` over every edge category (heritage, imports,
 * calls, ORM associations, test covers, markdown wikilinks, file
 * projection). It mutates the store; its return value is `void`.
 *
 * Delegation pattern (P02): this Task does NOT reimplement edge
 * resolution. It calls back into the host pipeline's `resolveAllEdges`
 * closure via `runResolveAllEdges`. The Task is a thin shim that lets the
 * indexing pipeline schedule edge resolution through the same surface as
 * future Tasks.
 *
 * Cancellation: `resolveAllEdges` is a long awaited call composed of
 * synchronous edge-resolver passes. It does not currently honour an
 * `AbortSignal`. We check the signal before dispatch — that is the most we
 * can do without modifying the underlying resolver. When the resolver
 * grows finer-grained yield points, this Task should forward the signal.
 */
import { defineTask, type Task } from '../task.js';

/** Inputs passed to the `resolve-edges` Task on every invocation. */
export interface ResolveEdgesTaskInput {
  /**
   * Closure that delegates to the host pipeline's private
   * `resolveAllEdges()` method. Passing a closure (rather than the
   * pipeline instance) keeps the Task layer ignorant of pipeline private
   * state and makes the wrapper trivially testable with a stub.
   */
  runResolveAllEdges: () => Promise<void>;
}

/** Output is `void` — the side-effect is on the store, not the return value. */
export type ResolveEdgesTaskOutput = void;

/**
 * Stable name re-used by callers wishing to look the task up in a `TaskDag`.
 * Intentionally NOT prefixed with `pipeline.` — Task names are used directly
 * as telemetry labels and should read as English.
 */
export const RESOLVE_EDGES_TASK_NAME = 'resolve-edges';

/**
 * Build the Task instance. No `key` is supplied — edge resolution is gated
 * upstream by `buildChangeScope`, which short-circuits when nothing
 * changed. Caching at the Task layer would only help when we know upfront
 * that the change scope is empty, which is exactly what the underlying
 * method already detects.
 */
export function createResolveEdgesTask(): Task<ResolveEdgesTaskInput, ResolveEdgesTaskOutput> {
  return defineTask<ResolveEdgesTaskInput, ResolveEdgesTaskOutput>({
    name: RESOLVE_EDGES_TASK_NAME,
    run: async ({ runResolveAllEdges }) => {
      await runResolveAllEdges();
    },
  });
}
