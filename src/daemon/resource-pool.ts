/**
 * ProjectResourcePool — owns the daemon-wide shared resources every managed
 * project's MCP server draws on: TopologyStore, DecisionStore, StateEngine.
 *
 * TRA-938: these three each back a single fixed file under TRACE_MCP_HOME
 * (topology.db / decisions.db / state.db) — the SAME file regardless of
 * which project asks for it. Earlier this pool still kept a separate
 * TopologyStore/DecisionStore per project root, so N loaded projects meant N
 * redundant SQLite connections (3 fds apiece) onto those three files. At
 * daemon scale that exhausted launchd's default 256 open-file soft limit,
 * which surfaced as accept() returning EMFILE and clients seeing "the daemon
 * was installed but never answered" — no crash, no log line naming the real
 * cause. Since the underlying file is process-global, so is this pool: one
 * TopologyStore/DecisionStore/StateEngine instance for the daemon's entire
 * lifetime, created lazily on first use and closed once, in disposeAll(), at
 * daemon shutdown.
 *
 * getRefCount() stays per-project — it backs the idle-unload / ephemeral-
 * sweep "is any client session still using this project" signal, which is
 * unrelated to how the shared files are opened.
 */

import * as path from 'node:path';
import type { TraceMcpConfig } from '../config.js';
import {
  DECISIONS_DB_PATH,
  ensureGlobalDirs,
  TRACE_MCP_HOME,
  TOPOLOGY_DB_PATH,
  STATE_DB_PATH,
} from '../global.js';
import { logger } from '../logger.js';
import { createAuditLogger } from '../memory/decision-audit-log.js';
import { DecisionStore } from '../memory/decision-store.js';
import type { ServerDeps } from '../server/server.js';
import { StateEngine } from '../state/state-engine.js';
import { TopologyStore } from '../topology/topology-db.js';

interface SharedResources {
  topoStore: TopologyStore | null;
  decisionStore: DecisionStore;
  stateEngine: StateEngine;
}

export class ProjectResourcePool {
  /** Per-project session refcount — see getRefCount(). Unrelated to `shared`. */
  private entries = new Map<string, { refCount: number }>();

  /** The daemon-wide singleton. Null until the first acquire()/getSharedDeps(). */
  private shared: SharedResources | null = null;

  /**
   * Create the shared resources on first call; a no-op afterwards. The first
   * caller's config wins for whether topology tracking and the decision
   * audit log are enabled — these are effectively daemon-wide files, so a
   * per-project override only matters for which project happens to open them
   * first.
   */
  private ensureShared(config: TraceMcpConfig): SharedResources {
    if (this.shared) return this.shared;
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
    const stateEngine = new StateEngine(STATE_DB_PATH);
    this.shared = { topoStore, decisionStore, stateEngine };
    logger.debug({ auditLog: !!auditLogger }, 'Resource pool: opened daemon-wide shared resources');
    return this.shared;
  }

  /**
   * Return the shared TopologyStore/DecisionStore/StateEngine, creating them
   * on first call. Does NOT touch per-project refcounts — for callers that
   * aren't a client session (e.g. ProjectManager.addProject's own server,
   * which nothing ever connects a transport to) and must not affect the
   * idle-unload/ephemeral-sweep "is this project busy" signal read via
   * getRefCount().
   */
  getSharedDeps(config: TraceMcpConfig): ServerDeps {
    const shared = this.ensureShared(config);
    return {
      topoStore: shared.topoStore,
      decisionStore: shared.decisionStore,
      stateEngine: shared.stateEngine,
    };
  }

  /**
   * Acquire shared resources for a project session. Increments that
   * project's refcount (read back via getRefCount()).
   */
  acquire(projectRoot: string, config: TraceMcpConfig): ServerDeps {
    const deps = this.getSharedDeps(config);
    const entry = this.entries.get(projectRoot) ?? { refCount: 0 };
    entry.refCount++;
    this.entries.set(projectRoot, entry);
    logger.debug({ projectRoot, refCount: entry.refCount }, 'Resource pool: acquired');
    return deps;
  }

  /** Release a project session's reference. The shared resources stay open
   *  regardless — other projects, or a future reload of this one, still need
   *  them; they only close in disposeAll(). */
  release(projectRoot: string): void {
    const entry = this.entries.get(projectRoot);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    logger.debug({ projectRoot, refCount: entry.refCount }, 'Resource pool: released');
  }

  /** Forget a stopped project's own refcount bookkeeping. Idempotent. Does
   *  not close the shared resources — see class doc. */
  disposeProject(projectRoot: string): void {
    this.entries.delete(projectRoot);
  }

  /** Close the daemon-wide shared resources. Call once, at daemon shutdown. */
  disposeAll(): void {
    this.entries.clear();
    if (!this.shared) return;
    try {
      this.shared.topoStore?.close();
    } catch {
      /* best-effort */
    }
    try {
      this.shared.decisionStore.close();
    } catch {
      /* best-effort */
    }
    try {
      this.shared.stateEngine.close();
    } catch {
      /* best-effort */
    }
    this.shared = null;
    logger.debug('Resource pool: closed daemon-wide shared resources');
  }

  /** Current session count for a project — used to gate idle-unload /
   *  ephemeral-sweep eviction, not the shared resources' lifecycle. */
  getRefCount(projectRoot: string): number {
    return this.entries.get(projectRoot)?.refCount ?? 0;
  }
}
