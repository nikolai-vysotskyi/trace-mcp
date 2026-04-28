/**
 * ProjectResourcePool — manages shared project-level resources for the daemon.
 *
 * Resources like TopologyStore and DecisionStore are expensive (SQLite connections)
 * and should be shared across all MCP sessions for the same project instead of
 * being created per-session. This pool uses reference counting to track active
 * sessions and closes resources when no sessions remain.
 */

import type { TraceMcpConfig } from '../config.js';
import { DECISIONS_DB_PATH, ensureGlobalDirs, TOPOLOGY_DB_PATH } from '../global.js';
import { logger } from '../logger.js';
import { DecisionStore } from '../memory/decision-store.js';
import type { ServerDeps } from '../server/server.js';
import { TopologyStore } from '../topology/topology-db.js';

interface PoolEntry {
  topoStore: TopologyStore | null;
  decisionStore: DecisionStore;
  refCount: number;
}

export class ProjectResourcePool {
  private pools = new Map<string, PoolEntry>();

  /**
   * Acquire shared resources for a project. Increments refCount.
   * Creates resources on first acquisition.
   */
  acquire(projectRoot: string, config: TraceMcpConfig): ServerDeps {
    let entry = this.pools.get(projectRoot);
    if (!entry) {
      ensureGlobalDirs();
      const topoStore = config.topology?.enabled ? new TopologyStore(TOPOLOGY_DB_PATH) : null;
      const decisionStore = new DecisionStore(DECISIONS_DB_PATH);
      entry = { topoStore, decisionStore, refCount: 0 };
      this.pools.set(projectRoot, entry);
      logger.debug({ projectRoot }, 'Resource pool: created shared resources');
    }
    entry.refCount++;
    logger.debug({ projectRoot, refCount: entry.refCount }, 'Resource pool: acquired');
    return {
      topoStore: entry.topoStore,
      decisionStore: entry.decisionStore,
    };
  }

  /**
   * Release a reference. When refCount drops to 0, resources are NOT closed
   * (they may be reused by the next session). Use disposeProject() for explicit cleanup.
   */
  release(projectRoot: string): void {
    const entry = this.pools.get(projectRoot);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    logger.debug({ projectRoot, refCount: entry.refCount }, 'Resource pool: released');
  }

  /** Close resources for a specific project and remove from pool. */
  disposeProject(projectRoot: string): void {
    const entry = this.pools.get(projectRoot);
    if (!entry) return;
    try {
      entry.topoStore?.close();
    } catch {
      /* best-effort */
    }
    try {
      entry.decisionStore.close();
    } catch {
      /* best-effort */
    }
    this.pools.delete(projectRoot);
    logger.debug({ projectRoot }, 'Resource pool: disposed project resources');
  }

  /** Close all resources across all projects. */
  disposeAll(): void {
    for (const [root] of this.pools) {
      this.disposeProject(root);
    }
  }

  /** Get current session count for a project. */
  getRefCount(projectRoot: string): number {
    return this.pools.get(projectRoot)?.refCount ?? 0;
  }
}
