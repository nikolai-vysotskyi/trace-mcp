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
