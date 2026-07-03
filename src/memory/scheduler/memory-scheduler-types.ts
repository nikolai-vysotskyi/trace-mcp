/**
 * Shared types for `MemoryScheduler` and `MemorySchedulerResourceOps`.
 *
 * Dependency-free leaf module — MUST NOT import from `memory-scheduler.ts`
 * or `memory-scheduler-resource-ops.ts`. Extracted so both files can share
 * these definitions without either one importing back from the other,
 * which previously created a circular import
 * (mirrors the `decision-types.ts` / `topology-types.ts` pattern used by
 * the `DecisionStore` and `TopologyStore` decompositions).
 */

import type { TraceMcpConfig } from '../../config.js';

export type StageName = 'mine' | 'cluster' | 'memo' | 'tune';

/**
 * A project's view of the scheduler's per-project state. Kept in memory
 * only — restarting the daemon resets everything; the underlying stores
 * (decisions, clusters, memos) are durable on their own.
 */
export interface SchedulerProjectState {
  lastMineAt?: number;
  lastClusterAt?: number;
  lastMemoAt?: number;
  lastTuneAt?: number;
  lastActivityAt?: number;
  pendingStages: Set<StageName>;
  consecutiveFailures: number;
  /** Epoch ms at which a project re-enters the rotation after a back-off. */
  backoffUntil?: number;
  /**
   * Decision count snapshot the last time a cluster run completed. Used
   * to detect "≥ clusterEveryNDecisions added" without expensive scans.
   */
  decisionsAtLastCluster?: number;
  /**
   * Review-event count at the last tune run. Used to detect
   * "≥ tuneEveryNNewEvents accumulated" without expensive scans.
   */
  lastTuneEventCount?: number;
}

/**
 * Minimal shape `MemoryScheduler` consumes from the project manager.
 * Avoids a circular type dep on `src/daemon/project-manager.ts` while
 * still letting tests inject a fake.
 */
export interface SchedulerProjectListing {
  /** Project root path (used as the in-memory state key). */
  root: string;
  /** Per-project trace-mcp config (for memo enabled/everyN, etc.). */
  config?: TraceMcpConfig;
}
