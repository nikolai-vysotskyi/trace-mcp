/**
 * `lsp-enrichment` Task — adapter wrapping the existing
 * `IndexingPipeline.runLspEnrichment` pass (src/indexer/pipeline.ts:680).
 *
 * The underlying method:
 *   1. Returns early when `config.lsp.enabled` is false.
 *   2. Dynamically imports `LspBridge`, runs `enrich()`, and shuts down.
 *   3. Catches and logs failures so a misbehaving LSP server cannot abort
 *      the rest of the pipeline.
 *
 * Delegation pattern (P02): this Task does NOT reimplement LSP enrichment.
 * It calls back into the host pipeline's `runLspEnrichment` closure. The
 * dynamic import + error swallowing semantics live in the original method
 * and stay there.
 *
 * Cancellation: the LSP bridge owns a child-process LSP server and a JSON
 * RPC stream. Aborting mid-enrichment requires plumbing the signal into
 * the bridge, which is out of scope for this slice — we only check the
 * signal before dispatch.
 */
import { defineTask, type Task } from '../task.js';

/** Inputs passed to the `lsp-enrichment` Task on every invocation. */
export interface LspEnrichmentTaskInput {
  /**
   * Closure that delegates to the host pipeline's private
   * `runLspEnrichment()` method. Passing a closure keeps the Task layer
   * ignorant of pipeline private state and makes the wrapper trivially
   * testable with a stub.
   */
  runLspEnrichment: () => Promise<void>;
}

/** Output is `void` — the side-effect is on the store, not the return value. */
export type LspEnrichmentTaskOutput = void;

/**
 * Stable name re-used by callers wishing to look the task up in a `TaskDag`.
 * Intentionally NOT prefixed with `pipeline.` — Task names are used directly
 * as telemetry labels and should read as English.
 */
export const LSP_ENRICHMENT_TASK_NAME = 'lsp-enrichment';

/**
 * Build the Task instance. No `key` is supplied — LSP enrichment depends
 * on the entire symbol/edge table state plus external LSP servers, neither
 * of which the Task layer can pre-hash cheaply. The underlying method
 * already short-circuits on `config.lsp.enabled=false`, which is the
 * cheapest possible cache.
 */
export function createLspEnrichmentTask(): Task<LspEnrichmentTaskInput, LspEnrichmentTaskOutput> {
  return defineTask<LspEnrichmentTaskInput, LspEnrichmentTaskOutput>({
    name: LSP_ENRICHMENT_TASK_NAME,
    run: async ({ runLspEnrichment }) => {
      await runLspEnrichment();
    },
  });
}
