/**
 * MemoryScheduler — long-lived, daemon-side background scheduler that
 * advances each registered project's memory pyramid without explicit
 * MCP calls.
 *
 * Pipeline (per-project, evaluated each tick):
 *   Stage A: mine_sessions      — once `mineMinIntervalSec` has elapsed AND
 *                                  the project has had MCP activity within
 *                                  `idleWindowSec` AND is not in the cold
 *                                  bucket (`coldThresholdSec`).
 *   Stage B: cluster decisions  — once `clusterEveryNDecisions` new
 *                                  decisions have landed since the last
 *                                  cluster run AND an AI provider is up.
 *   Stage C: regenerate memo    — once `regenerateEveryN` (config.memory.memo)
 *                                  new decisions land since the latest memo
 *                                  AND an AI provider is up AND
 *                                  `config.memory.memo.enabled !== false`.
 *
 * Concurrency rules:
 *   - One global FIFO serial queue. At most ONE stage runs at any moment
 *     across ALL projects. Avoids LLM stampedes, embedding bursts, and
 *     SQLite write contention.
 *   - Each tick walks `projectManager.listProjects()` and ENQUEUES due
 *     stages; it does not run them inline. The queue drains in order.
 *   - A stage that throws is logged via the stage layer and rolled into
 *     the `consecutiveFailures` back-off counter. The queue itself stays
 *     alive.
 *
 * Activity hooks:
 *   - `notifyActivity(projectRoot?)` is called from the daemon's
 *     MCP-request path. When a projectRoot is supplied it bumps only that
 *     project's `lastActivityAt`; when omitted it bumps every project
 *     (coarse fallback for hooks that don't know the project).
 *   - The idle-debounce check (`activityDebounceSec`) skips mining while
 *     the user is mid-task; cold-bucket (`coldThresholdSec`) skips
 *     projects no one has touched in days.
 *
 * Off by default. Opt-in via `config.memory.background.enabled = true`.
 */

import type { AIProvider } from '../../ai/interfaces.js';
import { createAIProvider } from '../../ai/index.js';
import type { TraceMcpConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { DECISIONS_DB_PATH, ensureGlobalDirs } from '../../global.js';
import { DecisionStore } from '../decision-store.js';
import {
  runClusterStage,
  runMemoStage,
  runMineStage,
  runTuneStage,
  type ClusterStageResult,
  type MemoStageResult,
  type MineStageResult,
  type TuneStageResult,
} from './stages.js';
import { SerialQueue } from './serial-queue.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

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

export interface MemoryBackgroundConfig {
  enabled: boolean;
  tickIntervalSec: number;
  activityDebounceSec: number;
  idleWindowSec: number;
  coldThresholdSec: number;
  mineMinIntervalSec: number;
  clusterEveryNDecisions: number;
  failureBackoffSec: number;
  tuneCooldownSec: number;
  tuneEveryNNewEvents: number;
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

export interface SchedulerProjectSource {
  listProjects(): SchedulerProjectListing[];
}

export interface MemorySchedulerOptions {
  projectManager: SchedulerProjectSource;
  config: TraceMcpConfig;
  /** Optional override of the shared DecisionStore. Defaults to the
   *  global ~/.trace-mcp/decisions.db file the rest of the daemon uses. */
  decisionStore?: DecisionStore;
  /** Inject a clock for tests (default: `Date.now`). */
  now?: () => number;
  /** When `false` the scheduler does NOT register a setInterval; useful in
   *  tests that prefer manual `runTickForTests()` calls. */
  startInterval?: boolean;
}

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  queue: { size: number; busy: boolean };
  projects: Array<{
    root: string;
    consecutiveFailures: number;
    pendingStages: StageName[];
    lastMineAt?: number;
    lastClusterAt?: number;
    lastMemoAt?: number;
    lastTuneAt?: number;
    lastActivityAt?: number;
    backoffUntil?: number;
  }>;
  config: MemoryBackgroundConfig;
}

// ════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════

const MAX_CONSECUTIVE_FAILURES = 3;

// ════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════

export class MemoryScheduler {
  private readonly opts: MemorySchedulerOptions;
  private readonly bg: MemoryBackgroundConfig;
  private readonly queue = new SerialQueue();
  private readonly states = new Map<string, SchedulerProjectState>();
  /** Cached AI providers per project. Built lazily on first stage need. */
  private readonly aiProviders = new Map<string, AIProvider | null>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private ownsDecisionStore = false;
  private decisionStore: DecisionStore | null = null;

  constructor(opts: MemorySchedulerOptions) {
    this.opts = opts;
    this.bg = resolveBackgroundConfig(opts.config);
    this.now = opts.now ?? (() => Date.now());
    if (opts.decisionStore) {
      this.decisionStore = opts.decisionStore;
      this.ownsDecisionStore = false;
    }
  }

  /** True when `config.memory.background.enabled === true`. */
  get enabled(): boolean {
    return this.bg.enabled;
  }

  /** Begin the interval tick. No-op when disabled or already started. */
  start(): void {
    if (this.stopped) return;
    if (!this.bg.enabled) {
      logger.debug?.({}, 'memory-scheduler: disabled — start() is a no-op');
      return;
    }
    if (this.timer) return;
    if (this.opts.startInterval === false) return;
    // Hydrate per-project state from the durable scheduler_state table so
    // a daemon restart does NOT re-run every stage on tick 1.
    try {
      for (const project of this.opts.projectManager.listProjects()) {
        if (!this.states.has(project.root)) {
          this.states.set(project.root, this.hydrateOrInitState(project.root));
        }
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message ?? String(err) },
        'memory-scheduler: hydration on start() failed — continuing with empty state',
      );
    }
    const intervalMs = Math.max(10, this.bg.tickIntervalSec) * 1000;
    this.timer = setInterval(() => {
      this.runTick().catch((err) => {
        logger.warn(
          { err: (err as Error)?.message ?? String(err) },
          'memory-scheduler: tick threw — continuing',
        );
      });
    }, intervalMs);
    this.timer.unref?.();
    logger.info({ intervalMs, config: this.bg }, 'memory-scheduler: started');
  }

  /**
   * Stop the interval and wait for the serial queue to drain. After
   * `stop()` resolves no further stages will run.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await this.queue.drain();
    } catch {
      /* SerialQueue.drain swallows errors — defensive only */
    }
    if (this.ownsDecisionStore && this.decisionStore) {
      try {
        this.decisionStore.close();
      } catch {
        /* defensive */
      }
      this.decisionStore = null;
    }
  }

  /**
   * Hook from the daemon's MCP-request path. When `projectRoot` is given
   * we bump only that project; otherwise we bump every project we know.
   * Cheap O(1) per project — call from every request without worry.
   */
  notifyActivity(projectRoot?: string): void {
    if (!this.bg.enabled || this.stopped) return;
    const ts = this.now();
    if (projectRoot) {
      const st = this.states.get(projectRoot) ?? this.hydrateOrInitState(projectRoot);
      st.lastActivityAt = ts;
      this.states.set(projectRoot, st);
    } else {
      for (const project of this.opts.projectManager.listProjects()) {
        const st = this.states.get(project.root) ?? this.hydrateOrInitState(project.root);
        st.lastActivityAt = ts;
        this.states.set(project.root, st);
      }
    }
  }

  /**
   * Public hook for tests. Runs one tick synchronously and returns when
   * the queue has drained.
   */
  async runTickForTests(): Promise<void> {
    await this.runTick();
    await this.queue.drain();
  }

  /** Serializable diagnostic snapshot. Suitable for logs / debug endpoints. */
  getStatus(): SchedulerStatus {
    const projects = Array.from(this.states.entries()).map(([root, st]) => ({
      root,
      consecutiveFailures: st.consecutiveFailures,
      pendingStages: Array.from(st.pendingStages.values()),
      lastMineAt: st.lastMineAt,
      lastClusterAt: st.lastClusterAt,
      lastMemoAt: st.lastMemoAt,
      lastTuneAt: st.lastTuneAt,
      lastActivityAt: st.lastActivityAt,
      backoffUntil: st.backoffUntil,
    }));
    return {
      enabled: this.bg.enabled,
      running: !!this.timer,
      queue: { size: this.queue.size, busy: this.queue.busy },
      projects,
      config: this.bg,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // INTERNAL — TICK + DUE COMPUTATION
  // ────────────────────────────────────────────────────────────────────

  private async runTick(): Promise<void> {
    if (this.stopped || !this.bg.enabled) return;
    const projects = this.opts.projectManager.listProjects();
    for (const project of projects) {
      const due = this.computeDueStages(project);
      for (const stage of due) {
        this.enqueueStage(project, stage);
      }
    }
  }

  private computeDueStages(project: SchedulerProjectListing): StageName[] {
    const now = this.now();
    const st = this.states.get(project.root) ?? this.hydrateOrInitState(project.root);
    this.states.set(project.root, st);

    // Honour back-off for the whole project.
    if (st.backoffUntil && now < st.backoffUntil) return [];

    // Idle debounce — do nothing while the user appears to be actively
    // making MCP calls against this project.
    if (st.lastActivityAt && now - st.lastActivityAt < this.bg.activityDebounceSec * 1000) {
      return [];
    }

    const due: StageName[] = [];
    if (!st.pendingStages.has('mine') && this.isMineDue(st, now)) due.push('mine');
    if (!st.pendingStages.has('cluster') && this.isClusterDue(project, st)) {
      due.push('cluster');
    }
    if (!st.pendingStages.has('memo') && this.isMemoDue(project, st)) {
      due.push('memo');
    }
    if (!st.pendingStages.has('tune') && this.isTuneDue(project, st, now)) {
      due.push('tune');
    }
    return due;
  }

  /**
   * Stage D — auto-retune confidence weights. Due when:
   *   - tuning is not explicitly disabled in config
   *   - the cooldown since the last successful tune has elapsed
   *   - at least `tuneEveryNNewEvents` new review events have landed
   *     since the last tune (or there's never been a tune)
   */
  private isTuneDue(
    project: SchedulerProjectListing,
    st: SchedulerProjectState,
    now: number,
  ): boolean {
    const cfg = project.config ?? this.opts.config;
    if (cfg.memory?.weight_tuning?.enabled === false) return false;
    if (st.lastTuneAt && now - st.lastTuneAt < this.bg.tuneCooldownSec * 1000) {
      return false;
    }
    const store = this.ensureDecisionStore();
    if (!store) return false;
    let eventCount = 0;
    try {
      // listReviewEvents is project-scoped — cheap when project is empty.
      eventCount = store.listReviewEvents({ project_root: project.root }).length;
    } catch {
      return false;
    }
    const baseline = st.lastTuneEventCount ?? 0;
    return eventCount - baseline >= this.bg.tuneEveryNNewEvents;
  }

  private isMineDue(st: SchedulerProjectState, now: number): boolean {
    // Cold projects — skip entirely.
    if (st.lastActivityAt && now - st.lastActivityAt > this.bg.coldThresholdSec * 1000) {
      return false;
    }
    // Require some activity in the recent window. When we have NEVER
    // seen activity for this project, fall back to "let it run" — the
    // scheduler was registered explicitly via projectManager.
    if (st.lastActivityAt && now - st.lastActivityAt > this.bg.idleWindowSec * 1000) {
      return false;
    }
    if (st.lastMineAt && now - st.lastMineAt < this.bg.mineMinIntervalSec * 1000) {
      return false;
    }
    return true;
  }

  private isClusterDue(project: SchedulerProjectListing, st: SchedulerProjectState): boolean {
    const store = this.ensureDecisionStore();
    if (!store) return false;
    const aiProvider = this.ensureAiProvider(project);
    if (!aiProvider) return false;
    let totalActive = 0;
    try {
      // queryDecisions caps at limit; we don't need the rows here, just a
      // delta count vs the last cluster run snapshot. Approximate by
      // pulling a generous slice — clusters trigger off relative growth.
      const rows = store.queryDecisions({
        project_root: project.root,
        include_invalidated: false,
        limit: 500,
      });
      totalActive = rows.length;
    } catch {
      return false;
    }
    if (st.decisionsAtLastCluster === undefined) {
      // First-ever evaluation — require at least clusterEveryNDecisions
      // active decisions to fire so empty projects don't churn.
      return totalActive >= this.bg.clusterEveryNDecisions;
    }
    const delta = totalActive - st.decisionsAtLastCluster;
    return delta >= this.bg.clusterEveryNDecisions;
  }

  private isMemoDue(project: SchedulerProjectListing, _st: SchedulerProjectState): boolean {
    const memoCfg = (project.config ?? this.opts.config).memory?.memo;
    if (memoCfg?.enabled === false) return false;
    const everyN = memoCfg?.regenerateEveryN ?? this.opts.config.memory?.memo?.regenerateEveryN;
    const threshold = typeof everyN === 'number' ? everyN : 50;

    const store = this.ensureDecisionStore();
    if (!store) return false;
    const aiProvider = this.ensureAiProvider(project);
    if (!aiProvider) return false;
    let sinceLast = 0;
    try {
      sinceLast = store.countDecisionsSinceLastMemo({ project_root: project.root });
    } catch {
      return false;
    }
    return sinceLast >= threshold;
  }

  // ────────────────────────────────────────────────────────────────────
  // INTERNAL — ENQUEUE + RUN
  // ────────────────────────────────────────────────────────────────────

  private enqueueStage(project: SchedulerProjectListing, stage: StageName): void {
    const st = this.states.get(project.root)!;
    st.pendingStages.add(stage);
    void this.queue.enqueue(async () => {
      // Drop if the scheduler was stopped while this was queued.
      if (this.stopped) {
        st.pendingStages.delete(stage);
        return;
      }
      try {
        await this.runStage(project, stage);
      } finally {
        st.pendingStages.delete(stage);
      }
    });
  }

  private async runStage(project: SchedulerProjectListing, stage: StageName): Promise<void> {
    const store = this.ensureDecisionStore();
    if (!store) return;
    const aiProvider = this.ensureAiProvider(project);
    const projectConfig = project.config ?? this.opts.config;
    const inferenceModel = projectConfig.ai?.inference_model ?? 'default';
    const st = this.states.get(project.root)!;

    const onSuccess = (result: { ok: boolean }) => {
      if (result.ok) {
        st.consecutiveFailures = 0;
        st.backoffUntil = undefined;
      } else {
        // Non-throwing skip (e.g. no-ai-provider) is not a failure.
      }
    };
    const onFailure = (err?: string) => {
      st.consecutiveFailures++;
      if (st.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        st.backoffUntil = this.now() + this.bg.failureBackoffSec * 1000;
        logger.warn(
          {
            projectRoot: project.root,
            stage,
            failures: st.consecutiveFailures,
            backoffSec: this.bg.failureBackoffSec,
            err,
          },
          'memory-scheduler: backing off project after repeated stage failures',
        );
      }
    };

    try {
      if (stage === 'mine') {
        const result: MineStageResult = await runMineStage({
          decisionStore: store,
          projectRoot: project.root,
          aiProvider,
          inferenceModel,
          strategy: projectConfig.memory?.mining?.strategy ?? 'regex',
        });
        st.lastMineAt = this.now();
        onSuccess(result);
        if (!result.ok && !result.skipped) onFailure(result.error);
        this.persistStateAsync(project.root, {
          last_mine_at: st.lastMineAt,
          consecutive_failures: st.consecutiveFailures,
        });
        logger.debug?.(
          { projectRoot: project.root, stage, result },
          'memory-scheduler: stage done',
        );
      } else if (stage === 'cluster') {
        const result: ClusterStageResult = await runClusterStage({
          decisionStore: store,
          projectRoot: project.root,
          aiProvider,
          inferenceModel,
        });
        st.lastClusterAt = this.now();
        if (result.ok) {
          // Snapshot the current active-decisions count so the next tick
          // measures delta correctly.
          try {
            const rows = store.queryDecisions({
              project_root: project.root,
              include_invalidated: false,
              limit: 500,
            });
            st.decisionsAtLastCluster = rows.length;
          } catch {
            /* leave stale; will self-correct on next successful run */
          }
        }
        onSuccess(result);
        if (!result.ok && !result.skipped) onFailure(result.error);
        this.persistStateAsync(project.root, {
          last_cluster_at: st.lastClusterAt,
          consecutive_failures: st.consecutiveFailures,
        });
        logger.debug?.(
          { projectRoot: project.root, stage, result },
          'memory-scheduler: stage done',
        );
      } else if (stage === 'memo') {
        const result: MemoStageResult = await runMemoStage({
          decisionStore: store,
          projectRoot: project.root,
          aiProvider,
          inferenceModel,
          targetTokens: projectConfig.memory?.memo?.targetTokens,
        });
        st.lastMemoAt = this.now();
        onSuccess(result);
        if (!result.ok && !result.skipped) onFailure(result.error);
        this.persistStateAsync(project.root, {
          last_memo_at: st.lastMemoAt,
          consecutive_failures: st.consecutiveFailures,
        });
        logger.debug?.(
          { projectRoot: project.root, stage, result },
          'memory-scheduler: stage done',
        );
      } else if (stage === 'tune') {
        let result: TuneStageResult;
        try {
          result = await runTuneStage({
            store,
            projectRoot: project.root,
            minEvents: projectConfig.memory?.weight_tuning?.min_events,
          });
        } catch (e) {
          // runTuneStage swallows its own throws, but defend against
          // unexpected programmer-error throws so the scheduler can't die.
          result = {
            ok: false,
            error: (e as Error)?.message ?? String(e),
            durationMs: 0,
          };
        }
        // Snapshot regardless of ok/skipped/applied — cooldown is the
        // only thing keeping the scheduler from re-running this stage
        // every tick, and we want it to stick even when the fitter
        // refused a noisy batch.
        st.lastTuneAt = this.now();
        try {
          st.lastTuneEventCount = store.listReviewEvents({
            project_root: project.root,
          }).length;
        } catch {
          /* leave stale; next tick will pick up the right baseline */
        }
        onSuccess(result);
        if (!result.ok && !result.skipped) onFailure(result.error);
        this.persistStateAsync(project.root, {
          last_tune_at: st.lastTuneAt,
          last_tune_event_count: st.lastTuneEventCount ?? null,
          consecutive_failures: st.consecutiveFailures,
        });
        logger.debug?.(
          { projectRoot: project.root, stage, result },
          'memory-scheduler: stage done',
        );
      }
    } catch (err) {
      // Defensive — stage layer is supposed to swallow throws, but a
      // sudden OOM or programmer error must not kill the scheduler.
      const msg = (err as Error)?.message ?? String(err);
      onFailure(msg);
      this.persistStateAsync(project.root, {
        consecutive_failures: st.consecutiveFailures,
      });
      logger.warn(
        { projectRoot: project.root, stage, err: msg },
        'memory-scheduler: stage threw unexpectedly',
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // INTERNAL — RESOURCE RESOLUTION
  // ────────────────────────────────────────────────────────────────────

  private initState(): SchedulerProjectState {
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
  private hydrateOrInitState(projectRoot: string): SchedulerProjectState {
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
  private persistStateAsync(
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

  private ensureDecisionStore(): DecisionStore | null {
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

  private ensureAiProvider(project: SchedulerProjectListing): AIProvider | null {
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
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

/** Folds nullable raw config into a fully-resolved background block with defaults. */
function resolveBackgroundConfig(config: TraceMcpConfig): MemoryBackgroundConfig {
  const raw = (config.memory as { background?: Partial<MemoryBackgroundConfig> })?.background ?? {};
  return {
    enabled: raw.enabled ?? false,
    tickIntervalSec: raw.tickIntervalSec ?? 60,
    activityDebounceSec: raw.activityDebounceSec ?? 120,
    idleWindowSec: raw.idleWindowSec ?? 3600,
    coldThresholdSec: raw.coldThresholdSec ?? 86400,
    mineMinIntervalSec: raw.mineMinIntervalSec ?? 1800,
    clusterEveryNDecisions: raw.clusterEveryNDecisions ?? 25,
    failureBackoffSec: raw.failureBackoffSec ?? 3600,
    tuneCooldownSec: raw.tuneCooldownSec ?? 86400,
    tuneEveryNNewEvents: raw.tuneEveryNNewEvents ?? 25,
  };
}

/** Exposed for tests that want to assert the defaults applied. */
export const _internal = { resolveBackgroundConfig };
