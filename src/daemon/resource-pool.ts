/**
 * ProjectResourcePool — manages shared project-level resources for the daemon.
 *
 * Resources like TopologyStore and DecisionStore are expensive (SQLite connections)
 * and should be shared across all MCP sessions for the same project instead of
 * being created per-session. This pool uses reference counting to track active
 * sessions and closes resources when no sessions remain.
 */

import * as path from 'node:path';
import type { TraceMcpConfig } from '../config.js';
import {
  DECISIONS_DB_PATH,
  ensureGlobalDirs,
  TRACE_MCP_HOME,
  TOPOLOGY_DB_PATH,
} from '../global.js';
import { logger } from '../logger.js';
import { createAuditLogger } from '../memory/decision-audit-log.js';
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
   * Grace period before idle (refCount === 0) project resources are closed.
   * Lets a fast reconnect reuse the live SQLite handles instead of paying the
   * reopen cost, while still releasing handles for projects that go quiet.
   */
  private readonly idleGraceMs = 60_000;

  /** Pending idle-close timers, keyed by projectRoot. */
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Cancel and forget any pending idle-close timer for a project. */
  private clearIdleTimer(projectRoot: string): void {
    const timer = this.idleTimers.get(projectRoot);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(projectRoot);
    }
  }

  /**
   * Acquire shared resources for a project. Increments refCount.
   * Creates resources on first acquisition.
   */
  acquire(projectRoot: string, config: TraceMcpConfig): ServerDeps {
    // A reconnect arrived before the idle grace period fired — keep the live
    // handles by cancelling the pending close.
    this.clearIdleTimer(projectRoot);
    let entry = this.pools.get(projectRoot);
    if (!entry) {
      ensureGlobalDirs();
      const topoStore = config.topology?.enabled ? new TopologyStore(TOPOLOGY_DB_PATH) : null;
      // Opt-in JSONL audit log alongside SQLite. Best-effort writes inside
      // the store — a misconfigured directory must not break decision
      // mutations. Defaults the directory to ~/.trace-mcp/decisions/.
      const auditCfg = config.memory?.audit_log;
      const auditLogger = auditCfg?.enabled
        ? createAuditLogger({
            dir: auditCfg.dir ?? path.join(TRACE_MCP_HOME, 'decisions'),
            retentionDays: auditCfg.retentionDays,
          })
        : null;
      const decisionStore = new DecisionStore(DECISIONS_DB_PATH, {
        auditLogger,
        memoHistoryLimit: config.memory?.memo?.historyLimit,
      });
      entry = { topoStore, decisionStore, refCount: 0 };
      this.pools.set(projectRoot, entry);
      logger.debug(
        { projectRoot, auditLog: !!auditLogger },
        'Resource pool: created shared resources',
      );
    }
    entry.refCount++;
    logger.debug({ projectRoot, refCount: entry.refCount }, 'Resource pool: acquired');
    return {
      topoStore: entry.topoStore,
      decisionStore: entry.decisionStore,
    };
  }

  /**
   * Release a reference. When refCount drops to 0, resources are scheduled to
   * be closed after an idle grace period (idleGraceMs) rather than held open
   * forever. A reconnect within the grace window cancels the close via
   * acquire(). The fire-time guard re-checks refCount so a session that
   * arrived after the timer was armed keeps the handles alive.
   */
  release(projectRoot: string): void {
    const entry = this.pools.get(projectRoot);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    logger.debug({ projectRoot, refCount: entry.refCount }, 'Resource pool: released');
    if (entry.refCount === 0) {
      // Replace any earlier pending timer (defensive — acquire normally
      // clears it) so we never leak overlapping timers for one project.
      this.clearIdleTimer(projectRoot);
      const timer = setTimeout(() => {
        this.idleTimers.delete(projectRoot);
        // Only close if still idle — a reconnect may have re-acquired since
        // the timer was armed.
        if ((this.pools.get(projectRoot)?.refCount ?? 0) === 0) {
          this.disposeProject(projectRoot);
        }
      }, this.idleGraceMs);
      // Do not keep the daemon process alive solely for this cleanup timer.
      timer.unref?.();
      this.idleTimers.set(projectRoot, timer);
    }
  }

  /** Close resources for a specific project and remove from pool. Idempotent. */
  disposeProject(projectRoot: string): void {
    // Always clear any pending idle timer first — even if the project is
    // already gone — so a stale timer can never fire on a disposed project.
    this.clearIdleTimer(projectRoot);
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
    // Snapshot keys: disposeProject mutates this.pools while iterating.
    for (const root of [...this.pools.keys()]) {
      this.disposeProject(root);
    }
    // Defensive sweep — clear any idle timers for projects that were never in
    // the pool map (none expected, but keeps the timer map from leaking).
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();
  }

  /** Get current session count for a project. */
  getRefCount(projectRoot: string): number {
    return this.pools.get(projectRoot)?.refCount ?? 0;
  }
}
