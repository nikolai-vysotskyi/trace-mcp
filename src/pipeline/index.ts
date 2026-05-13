/**
 * Public surface of the composable Task DAG. See `task.ts` for the contract
 * and `tasks/` for migrated pipeline passes.
 */
export { TaskDag, defineTask } from './task.js';
export type { Task, TaskStepSummary, TaskComposeSummary } from './task.js';
export {
  createIndexEnvTask,
  INDEX_ENV_TASK_NAME,
  type IndexEnvTaskInput,
  type IndexEnvTaskOutput,
} from './tasks/index-env-task.js';
export {
  createResolveEdgesTask,
  RESOLVE_EDGES_TASK_NAME,
  type ResolveEdgesTaskInput,
  type ResolveEdgesTaskOutput,
} from './tasks/resolve-edges-task.js';
export {
  createLspEnrichmentTask,
  LSP_ENRICHMENT_TASK_NAME,
  type LspEnrichmentTaskInput,
  type LspEnrichmentTaskOutput,
} from './tasks/lsp-enrichment-task.js';
export {
  createGraphSnapshotsTask,
  GRAPH_SNAPSHOTS_TASK_NAME,
  type GraphSnapshotsTaskInput,
  type GraphSnapshotsTaskOutput,
} from './tasks/graph-snapshots-task.js';
