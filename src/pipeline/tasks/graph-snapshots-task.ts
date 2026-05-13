/**
 * `graph-snapshots` Task — adapter wrapping the existing
 * `captureGraphSnapshots` function (src/tools/analysis/history.ts:540),
 * which is invoked once per full reindex in `IndexingPipeline.runPipeline`
 * (src/indexer/pipeline.ts:361) to capture git-history coupling / churn
 * snapshots into the store.
 *
 * Why this pass was chosen for this slice:
 *
 *  - It is a pure function call — `captureGraphSnapshots(store, rootPath)`
 *    with no surrounding mutation that would leak across a Task boundary.
 *  - It is gated upstream by `_postprocessLevel === 'full'`,
 *    `!_isIncremental`, and `result.indexed > 0`. Those gates stay in the
 *    pipeline and the Task is only invoked when they pass.
 *  - It is wrapped in `try/catch` in the original site — failures are
 *    logged but never abort indexing. The Task preserves that error policy
 *    by letting the caller keep its try/catch around the `dag.run` call.
 *  - It is OFF the hot path. A regression in snapshot capture cannot harm
 *    symbol extraction or edge resolution.
 *
 * Delegation pattern (P02): this Task does NOT reimplement snapshot
 * capture. It calls back into the host pipeline's snapshot closure. The
 * pipeline owns the decision of WHEN to take a snapshot; the Task owns
 * HOW the call is scheduled.
 *
 * Cancellation: `captureGraphSnapshots` is synchronous (`void` return,
 * wrapped in a Promise here for uniformity). We check the signal before
 * dispatch — there is no awaited interior to forward the signal into.
 */
import { defineTask, type Task } from '../task.js';

/** Inputs passed to the `graph-snapshots` Task on every invocation. */
export interface GraphSnapshotsTaskInput {
  /**
   * Closure that delegates to the underlying `captureGraphSnapshots(store,
   * rootPath)` call. Passing a closure keeps the Task layer ignorant of
   * the store / rootPath plumbing and makes the wrapper trivially testable
   * with a stub.
   */
  captureSnapshots: () => void;
}

/** Output is `void` — the side-effect is on the store, not the return value. */
export type GraphSnapshotsTaskOutput = void;

/**
 * Stable name re-used by callers wishing to look the task up in a `TaskDag`.
 * Intentionally NOT prefixed with `pipeline.` — Task names are used directly
 * as telemetry labels and should read as English.
 */
export const GRAPH_SNAPSHOTS_TASK_NAME = 'graph-snapshots';

/**
 * Build the Task instance. No `key` is supplied — snapshot capture is
 * cheap when nothing changed (the underlying history writer detects an
 * unchanged HEAD), but the Task layer cannot pre-hash the entire store
 * state. The pipeline-level gates (`indexed > 0`, full postprocess,
 * non-incremental) are the right place for cache decisions.
 */
export function createGraphSnapshotsTask(): Task<
  GraphSnapshotsTaskInput,
  GraphSnapshotsTaskOutput
> {
  return defineTask<GraphSnapshotsTaskInput, GraphSnapshotsTaskOutput>({
    name: GRAPH_SNAPSHOTS_TASK_NAME,
    run: async ({ captureSnapshots }) => {
      captureSnapshots();
    },
  });
}
