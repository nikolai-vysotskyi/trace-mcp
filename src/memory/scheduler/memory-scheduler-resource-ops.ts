/**
 * Resource resolution — extracted from `MemoryScheduler` (Task: god-class
 * decomposition, mirrors the DecisionStore extraction pattern). Owns:
 *   - lazy `DecisionStore` open/close (global ~/.trace-mcp/decisions.db,
 *     unless the caller injected one via `MemorySchedulerOptions.decisionStore`)
 *   - per-project `AIProvider` construction/caching
 *   - per-project state hydration from the durable `scheduler_state` table
 *   - fire-and-forget persistence of per-project scheduler bookkeeping
 *
 * `MemoryScheduler` holds one `MemorySchedulerResourceOps` instance and
 * delegates its private resource-resolution methods to it verbatim — the
 * public API and behavior are unchanged, only the implementation moved.
 */

import type { AIProvider } from '../../ai/interfaces.js';
import { createAIProvider } from '../../ai/index.js';
import type { TraceMcpConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { DECISIONS_DB_PATH, ensureGlobalDirs } from '../../global.js';
import { DecisionStore } from '../decision-store.js';
import type {
  SchedulerProjectListing,
  StageName,
  SchedulerProjectState,
} from './memory-scheduler-types.js';

export interface MemorySchedulerResourceOptions {
  config: TraceMcpConfig;
  decisionStore?: DecisionStore;
}

export class MemorySchedulerResourceOps {
  private readonly opts: MemorySchedulerResourceOptions;
  /** Cached AI providers per project. Built lazily on first stage need. */
  private readonly aiProviders = new Map<string, AIProvider | null>();
  private ownsDecisionStore = false;
  private decisionStore: DecisionStore | null = null;

  constructor(opts: MemorySchedulerResourceOptions) {
    this.opts = opts;
    if (opts.decisionStore) {
      this.decisionStore = opts.decisionStore;
      this.ownsDecisionStore = false;
    }
  }

  /** True when this instance opened its own DecisionStore (vs. injected). */
  get ownsStore(): boolean {
    return this.ownsDecisionStore;
  }

  /** The currently-open DecisionStore, if any (does not open one). */
  get currentStore(): DecisionStore | null {
    return this.decisionStore;
  }

  /** Close the owned store (no-op when injected). Mirrors old stop() logic. */
  closeOwnedStore(): void {
    if (this.ownsDecisionStore && this.decisionStore) {
      try {
        this.decisionStore.close();
      } catch {
        /* defensive */
      }
      this.decisionStore = null;
    }
  }

  ensureDecisionStore(): DecisionStore | null {
    if (this.decisionStore) return this.decisionStore;
    try {
      ensureGlobalDirs();
      this.decisionStore = new DecisionStore(DECISIONS_DB_PATH);
      this.ownsDecisionStore = true;
      return this.decisionStore;
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message ?? String(err) },
        'memory-scheduler: failed to open DecisionStore — disabling',
      );
      return null;
    }
  }

  ensureAiProvider(project: SchedulerProjectListing): AIProvider | null {
    const key = project.root;
    if (this.aiProviders.has(key)) return this.aiProviders.get(key) ?? null;
    const cfg = project.config ?? this.opts.config;
    if (!cfg.ai?.enabled) {
      this.aiProviders.set(key, null);
      return null;
    }
    try {
      const provider = createAIProvider(cfg);
      this.aiProviders.set(key, provider);
      return provider;
    } catch (err) {
      logger.warn(
        { projectRoot: project.root, err: (err as Error)?.message ?? String(err) },
        'memory-scheduler: createAIProvider failed — disabling AI stages for project',
      );
      this.aiProviders.set(key, null);
      return null;
    }
  }

  initState(): SchedulerProjectState {
    return {
      pendingStages: new Set<StageName>(),
      consecutiveFailures: 0,
    };
  }

  /**
   * Build per-project state, hydrating timestamps from the durable
   * `scheduler_state` table when possible. Falls back to a fresh
   * `initState()` when no row exists OR the store can't be opened
   * (e.g. read-only filesystem in tests).
   *
   * Hydration is best-effort — any failure logs and returns init state.
   */
  hydrateOrInitState(projectRoot: string): SchedulerProjectState {
    const fresh = this.initState();
    const store = this.ensureDecisionStore();
    if (!store) return fresh;
    try {
      const row = store.getSchedulerState(projectRoot);
      if (!row) return fresh;
      if (row.last_mine_at !== null) fresh.lastMineAt = row.last_mine_at;
      if (row.last_cluster_at !== null) fresh.lastClusterAt = row.last_cluster_at;
      if (row.last_memo_at !== null) fresh.lastMemoAt = row.last_memo_at;
      if (row.last_tune_at !== null) fresh.lastTuneAt = row.last_tune_at;
      if (row.last_tune_event_count !== null) {
        fresh.lastTuneEventCount = row.last_tune_event_count;
      }
      fresh.consecutiveFailures = row.consecutive_failures;
      return fresh;
    } catch (err) {
      logger.debug?.(
        { projectRoot, err: (err as Error)?.message ?? String(err) },
        'memory-scheduler: hydrateOrInitState fell back to init state',
      );
      return fresh;
    }
  }

  /**
   * Fire-and-forget persistence of per-project scheduler bookkeeping.
   * MUST NEVER block or throw out of stage completion — a failed write
   * here is a missed restart-resume, not a stage failure.
   */
  persistStateAsync(
    projectRoot: string,
    patch: {
      last_mine_at?: number | null;
      last_cluster_at?: number | null;
      last_memo_at?: number | null;
      last_tune_at?: number | null;
      last_tune_event_count?: number | null;
      consecutive_failures?: number;
    },
  ): void {
    const store = this.ensureDecisionStore();
    if (!store) return;
    try {
      store.upsertSchedulerState({ project_root: projectRoot, ...patch });
    } catch (err) {
      logger.debug?.(
        { projectRoot, err: (err as Error)?.message ?? String(err) },
        'memory-scheduler: persistStateAsync failed — restart will not see this tick',
      );
    }
  }
}
