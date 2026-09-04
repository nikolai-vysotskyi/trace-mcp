import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import {
  BlobVectorStore,
  CachedInferenceService,
  createAIProvider,
  EmbeddingPipeline,
  InferenceCache,
} from '../ai/index.js';
import { SummarizationPipeline } from '../ai/summarization-pipeline.js';
import type { TraceMcpConfig } from '../config.js';
import { loadConfig, loadGlobalConfigRaw } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { announceDbHolder, releaseDbHoldersForRoot } from '../db-holders.js';
import { ensureGlobalDirs, getDbPath, TOPOLOGY_DB_PATH } from '../global.js';
import { ExtractPool } from '../indexer/extract-pool.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import {
  clearProjectReindexCache,
  shouldSkipRecentReindex,
} from '../indexer/recent-reindex-cache.js';
import { FileWatcher } from '../indexer/watcher.js';
import { logger } from '../logger.js';
import { BackgroundLspEnricher } from '../lsp/background-enricher.js';
import { getReindexStats } from './reindex-stats.js';
import { SqliteTaskCache } from '../pipeline/index.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { clearServerPid, ProgressState, writeServerPid } from '../progress.js';
import { detectGitWorktree } from '../project-root.js';
import { isDangerousProjectRoot, setupProject } from '../project-setup.js';
import {
  clearPendingReindex,
  descendantExcludeGlobs,
  findEphemeralProjects,
  findOverlappingProjects,
  getProject,
  listProjects,
  MAX_PENDING_REINDEX_ATTEMPTS,
  recordPendingReindexAttempt,
  unregisterProject,
  updateLastIndexed,
} from '../registry.js';
import type { ServerHandle } from '../server/server.js';
import { createServer } from '../server/server.js';
import { SubprojectManager } from '../subproject/manager.js';
import { TopologyStore } from '../topology/topology-db.js';
import { trailingDebounce } from '../util/debounce.js';
import { selectEagerLoadRoots } from './eager-load.js';
import { serializeError } from './log-error.js';
import {
  removeProjectArtifacts,
  type RemoveArtifactsOptions,
  type RemoveArtifactsResult,
} from './project-artifacts.js';
import type { ProjectResourcePool } from './resource-pool.js';

const AI_COALESCE_WAIT_MS = 5_000;

export interface ManagedProject {
  root: string;
  config: TraceMcpConfig;
  /** On-disk index DB this project opened. Also keys its holder marker (TRA-304). */
  dbPath: string;
  db: Database.Database;
  store: Store;
  registry: PluginRegistry;
  progress: ProgressState;
  pipeline: IndexingPipeline;
  watcher: FileWatcher;
  server: McpServer;
  serverHandle: ServerHandle;
  status: 'starting' | 'indexing' | 'ready' | 'error';
  error?: string;
  cancelDebouncedAI?: () => void;
  /** Aborted during stopProject() so in-flight AI fetches bail instead of
   *  running to completion against a now-disposed Store. */
  aiAbortController?: AbortController;
  /**
   * Phase 3 background LSP enricher — runs LSP enrichment scoped to a
   * watcher burst's changed files N seconds after the burst ends. Null
   * when LSP is disabled in config (the construction is gated on
   * `config.lsp?.enabled`).
   */
  lspEnricher?: BackgroundLspEnricher | null;
  /**
   * Epoch ms of the last request/watcher touch routed to this project.
   * Updated via `ProjectManager.touchActivity()`. Drives the idle-unload
   * sweep — see `project_idle_unload_minutes` config key.
   */
  lastAccessedAt: number;
  /**
   * The fire-and-forget initial `indexAll()` chain (indexing → summarization →
   * embeddings → subproject auto-sync, incl. any FK-recovery retries) kicked
   * off by `addProject()`. Never rejects — every branch of the chain catches
   * its own errors into `managed.status = 'error'`. `stopProject()` awaits
   * this before closing `managed.db` so a still-open topology.db handle from
   * `runSubprojectAutoSync()` can't outlive teardown (Windows holds file
   * handles exclusively, so a stale handle blocks the caller's subsequent
   * directory cleanup with EBUSY).
   */
  initialIndexPromise?: Promise<void>;
}

async function runSubprojectAutoSync(projectRoot: string, config: TraceMcpConfig): Promise<void> {
  if (config.topology?.enabled === false) return;
  if (config.topology?.auto_discover === false) return;
  // WHY finally-close: this runs once per addProject() (every register + every
  // daemon-restart reload of every project). Without close() each call leaked a
  // better-sqlite3 handle + fds on the shared topology.db, accumulating over the
  // daemon's lifetime. Mirror of runSubprojectAutoSyncSafe / dropTopologyRows.
  let topoStore: TopologyStore | undefined;
  try {
    ensureGlobalDirs();
    topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    const manager = new SubprojectManager(topoStore);
    await manager.autoDiscoverSubprojects(projectRoot, {
      contractPaths: config.topology?.contract_globs,
    });
  } catch (err) {
    logger.warn({ error: err, projectRoot }, 'Subproject auto-sync failed (non-fatal)');
  } finally {
    topoStore?.close();
  }
}

/**
 * Minimal in-flight concurrency limiter. Returns a function that wraps an
 * async fn so at most `n` calls run at once; subsequent calls queue.
 * Inlined to avoid pulling p-limit for ~15 LOC. See plan-indexer-perf §2.3.
 * Exported so tests can verify the cap independently of the daemon.
 */
export function pLimit(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  // WHY release(): a thrown resolver must not leak the slot — wrap in try/catch.
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) {
      try {
        next();
      } catch {
        /* defensive: a thrown resolver must not leak the slot */
      }
    }
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) {
      await new Promise<void>((r) => queue.push(r));
    }
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export class ProjectManager {
  private projects = new Map<string, ManagedProject>();
  /** Singleton, shared across every managed project. Bounds the daemon's
   *  worker thread count regardless of project count. Lazy-init on the first
   *  addProject() so we can read the project's config for sizing. */
  private sharedPool: ExtractPool | null = null;
  /** Configurable cap on concurrent initial indexAll() calls. Watcher-driven
   *  indexFiles() is NOT gated. Lazy-init alongside sharedPool. */
  private indexAllLimit: ReturnType<typeof pLimit> | null = null;
  /** Optional shared TopologyStore/DecisionStore pool. When provided,
   *  stopProject() force-disposes the project's pool entry so the SQLite
   *  handles plus their in-memory state don't leak across the daemon's
   *  lifetime. Owned by cli.ts; injected here so tests can verify the wiring
   *  without dragging the HTTP layer in. */
  private resourcePool: ProjectResourcePool | null = null;
  /** Idle-unload sweep timer — see startIdleUnloadSweep(). Null when not running
   *  (never started, or stopped via stopIdleUnloadSweep()/shutdown()). */
  private idleUnloadTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: { resourcePool?: ProjectResourcePool }) {
    this.resourcePool = opts?.resourcePool ?? null;
  }

  /** Inject the shared resource pool after construction. Used by cli.ts
   *  because the pool is created after ProjectManager (legacy ordering).
   *  Idempotent — second call replaces the reference. */
  setResourcePool(pool: ProjectResourcePool): void {
    this.resourcePool = pool;
  }

  private ensureShared(config: TraceMcpConfig): void {
    if (!this.sharedPool) {
      this.sharedPool = new ExtractPool({
        keepAlive: true,
        size: config.indexer?.workers,
      });
    }
    if (!this.indexAllLimit) {
      this.indexAllLimit = pLimit(config.indexer?.parallel_initial_index ?? 2);
    }
  }

  /** Set up and start indexing for a single project. */
  async addProject(
    projectRoot: string,
    opts?: { watch?: boolean; persist?: boolean },
  ): Promise<ManagedProject> {
    const existing = this.projects.get(projectRoot);
    if (existing) return existing;

    // Read-mostly mode (a registered subproject served on-demand): index once,
    // no fs watcher, no registry.json / config-file writes. Stays in-memory for
    // the daemon's lifetime but is never restored as a watched project on the
    // next restart — it is re-resolved from topology.db on each connect. Keeps
    // umbrella repos with many subprojects from spawning N watchers (#209).
    const watch = opts?.watch ?? true;
    const persist = opts?.persist ?? true;

    const worktreeInfo = detectGitWorktree(projectRoot);
    const indexRoot = worktreeInfo?.mainRoot ?? projectRoot;

    if (worktreeInfo) {
      logger.info(
        { worktreeRoot: projectRoot, mainRoot: worktreeInfo.mainRoot },
        'Git worktree detected — sharing main repo index',
      );
    }

    // Standard registration: detect, config, DB, registry. Skipped for
    // read-mostly subprojects so they leave no config file in the repo and no
    // registry.json entry — loadConfig() below still yields a valid default
    // config, and the DB is created by initializeDatabase() a few lines down.
    if (persist) setupProject(projectRoot);

    const configResult = await loadConfig(projectRoot);
    if (configResult.isErr()) {
      throw new Error(`Failed to load config for ${projectRoot}: ${configResult.error}`);
    }
    const config = configResult.value;

    // TRA-38: prefer the registry's already-resolved dbPath (set moments ago
    // by setupProject(), which may have reused a same-git-remote sibling's
    // existing DB instead of a fresh one) over recomputing it from scratch.
    // Worktrees are deliberately excluded — they already share one dbPath
    // via `indexRoot` (the main worktree root), a separate, pre-existing
    // mechanism this must not disturb. Read-mostly subprojects (persist
    // false, never registered) simply find nothing and fall through to the
    // same getDbPath() call this line has always made.
    const dbPath = worktreeInfo
      ? getDbPath(indexRoot)
      : (getProject(indexRoot)?.dbPath ?? getDbPath(indexRoot));
    ensureGlobalDirs();

    // TRA-304: this process is about to hold `dbPath` open for the project's
    // whole lifetime — that, not registration, is what makes a sibling
    // checkout's reuse of the same DB concurrent rather than sequential. Cheap
    // and idempotent, so it also covers read-mostly subprojects that never
    // touched the registry.
    try {
      announceDbHolder(dbPath, projectRoot);
    } catch (err) {
      logger.warn({ err, projectRoot, dbPath }, 'failed to announce index-DB holder (non-fatal)');
    }

    const db = initializeDatabase(dbPath, {
      cacheMb: config.index_cache_mb,
      mmapMb: config.index_mmap_mb,
    });
    writeServerPid(db);
    const store = new Store(db);
    const registry = PluginRegistry.createWithDefaults();

    this.ensureShared(config);

    const progress = new ProgressState(db);
    // Daemon path: use the SQLite-backed task cache so pass outputs persist on
    // disk and never accumulate in the long-running daemon's heap. The
    // pipeline never owns this cache — the project's `db` does, and is
    // closed by `stopProject()`.
    const taskCache = new SqliteTaskCache(db);
    // Bound pass_cache row age — without this, every fresh (task, input-hash)
    // pair adds one row forever in a long-running daemon. Eviction is a
    // single indexed DELETE backed by idx_pass_cache_created (v28 migration).
    try {
      const ttlDays = config.pipeline?.task_cache_ttl_days ?? 30;
      const removed = taskCache.evictExpired(ttlDays * 86_400_000);
      if (removed > 0) {
        logger.info(
          { projectRoot, removed, ttlDays },
          'pass_cache: evicted expired rows on project start',
        );
      }
    } catch (err) {
      logger.warn(
        { error: serializeError(err), projectRoot },
        'pass_cache: TTL eviction failed (non-fatal)',
      );
    }
    const pipeline = new IndexingPipeline(store, registry, config, projectRoot, progress, {
      extractPool: this.sharedPool,
      taskCache,
    });
    const watcher = new FileWatcher();

    // AI pipelines (optional, lazy): construction is deferred until first use
    // so AI-enabled but never-summarized/embedded projects don't pay the
    // ~50-100 ms per-project setup cost at startup. See plan §5.3.
    const aiEnabled = !!config.ai?.enabled;
    const aiProvider = createAIProvider(config);
    const inferenceCache = aiEnabled ? new InferenceCache(store.db) : null;
    // evictExpired is cheap (single SQL DELETE) — fine to do eagerly.
    inferenceCache?.evictExpired();

    let vectorStore: BlobVectorStore | null = null;
    let embeddingPipeline: EmbeddingPipeline | null = null;
    let summarizationPipeline: SummarizationPipeline | null = null;

    const getVectorStore = (): BlobVectorStore | null => {
      if (!aiEnabled) return null;
      if (!vectorStore) vectorStore = new BlobVectorStore(store.db);
      return vectorStore;
    };

    const getEmbeddingPipeline = (): EmbeddingPipeline | null => {
      if (!aiEnabled) return null;
      if (embeddingPipeline) return embeddingPipeline;
      const vs = getVectorStore();
      if (!vs) return null;
      embeddingPipeline = new EmbeddingPipeline(store, aiProvider.embedding(), vs, progress);
      return embeddingPipeline;
    };

    const getSummarizationPipeline = (): SummarizationPipeline | null => {
      if (!aiEnabled) return null;
      if (config.ai!.summarize_on_index === false) return null;
      if (summarizationPipeline) return summarizationPipeline;
      summarizationPipeline = new SummarizationPipeline(
        store,
        new CachedInferenceService(
          aiProvider.fastInference(),
          inferenceCache!,
          config.ai!.fast_model ?? 'fast',
        ),
        projectRoot,
        {
          batchSize: config.ai!.summarize_batch_size ?? 20,
          kinds: config.ai!.summarize_kinds ?? [
            'class',
            'function',
            'method',
            'interface',
            'trait',
            'enum',
            'type',
          ],
          concurrency: config.ai!.concurrency ?? 1,
          summarizeFromDocstrings: config.ai!.summarizeFromDocstrings,
        },
        progress,
        getVectorStore(),
      );
      return summarizationPipeline;
    };

    // Per-project AbortController. Aborted by stopProject() so in-flight AI
    // fetches bail out instead of running to completion holding references
    // into a Store/ProjectContext the daemon has already disposed.
    const aiAbortController = new AbortController();

    const runEmbeddings = (signal?: AbortSignal) => {
      const p = getEmbeddingPipeline();
      if (!p) return;
      // The debounced wrapper passes its per-invocation signal; merge with the
      // project-level signal so either abort short-circuits the pipeline.
      const merged = signal ?? aiAbortController.signal;
      p.indexUnembedded(undefined, merged).catch((err) => {
        logger.error({ error: serializeError(err), projectRoot }, 'Embedding indexing failed');
      });
    };

    const runSummarization = (signal?: AbortSignal) => {
      const p = getSummarizationPipeline();
      if (!p) return;
      const merged = signal ?? aiAbortController.signal;
      p.summarizeUnsummarized(merged).catch((err) => {
        logger.error({ error: serializeError(err), projectRoot }, 'Summarization failed');
      });
    };

    // Use closure refs so the debounced fn can read its own current .signal
    // for the in-flight invocation (it's swapped on every fire).
    let summarizeRef: ReturnType<typeof trailingDebounce> | null = null;
    let embedRef: ReturnType<typeof trailingDebounce> | null = null;
    const debouncedSummarize = trailingDebounce(
      () => runSummarization(summarizeRef?.signal),
      AI_COALESCE_WAIT_MS,
    );
    summarizeRef = debouncedSummarize;
    const debouncedEmbed = trailingDebounce(
      () => runEmbeddings(embedRef?.signal),
      AI_COALESCE_WAIT_MS,
    );
    embedRef = debouncedEmbed;

    // Phase 3 background LSP enricher — only constructed when LSP is enabled
    // in config (opt-in by design). Watcher onChanges feeds it the changed
    // file IDs from each indexFiles() result; the enricher debounces the
    // burst and runs a scoped LSP enrichment off the hot path. See
    // src/lsp/background-enricher.ts.
    const lspEnricher: BackgroundLspEnricher | null = config.lsp?.enabled
      ? new BackgroundLspEnricher({ store, config, rootPath: projectRoot })
      : null;

    const serverHandle = createServer(store, registry, config, projectRoot, progress);

    const managed: ManagedProject = {
      root: projectRoot,
      config,
      dbPath,
      db,
      store,
      registry,
      progress,
      pipeline,
      watcher,
      server: serverHandle.server,
      serverHandle,
      status: 'starting',
      aiAbortController,
      lspEnricher,
      lastAccessedAt: Date.now(),
      cancelDebouncedAI: () => {
        debouncedSummarize.cancel();
        debouncedEmbed.cancel();
      },
    };

    this.projects.set(projectRoot, managed);

    // Start indexing in background, gated by the shared semaphore so adding
    // N projects at once doesn't fan out to N concurrent indexAll runs.
    managed.status = 'indexing';
    // Wrap initial indexAll in an FK-auto-recovery retry. When upgrading from
    // an older schema (e.g. v26 -> v28) the existing DB may carry stale rows
    // that were tolerated under the previous edge-resolution algorithm but
    // violate FK constraints under the new one. Re-running with force=true
    // wipes the symbol/edge tables and rebuilds them in correct order from
    // source files, which clears the orphan rows. We only retry ONCE and we
    // only retry for FK errors — every other failure surfaces immediately so
    // we don't mask real bugs.
    const isForeignKeyError = (err: unknown): boolean => {
      const msg = err instanceof Error ? err.message : String(err);
      return /FOREIGN KEY constraint failed/i.test(msg);
    };
    // Lazy post-update reindex: if updater.ts stamped pendingReindexForVersion
    // on this project's registry entry, run the initial indexAll with force=true
    // (full rebuild) instead of the cheap incremental path. Clears the flag on
    // success so subsequent restarts go through the fast path. This decouples
    // "trace-mcp version bump" from "reindex storm in post-update migrations",
    // which used to block the event loop long enough that the desktop app's
    // /health watchdog shot the daemon with `daemon restart`. See updater.ts.
    // TRA-274: the flag used to be cleared only on SUCCESS. On a machine where
    // many concurrent CLI sessions share one launchd daemon, the mass rebuild
    // starves /health, a session restarts the daemon, and no project ever
    // finishes — so every boot force-rebuilt every project again, forever.
    // Burn an attempt BEFORE the rebuild starts and give up past the cap.
    const registryEntry = getProject(projectRoot);
    let needsForcedReindex = registryEntry?.pendingReindexForVersion !== undefined;
    if (needsForcedReindex) {
      const attempt = recordPendingReindexAttempt(projectRoot);
      if (attempt > MAX_PENDING_REINDEX_ATTEMPTS) {
        needsForcedReindex = false;
        logger.warn(
          { projectRoot, forVersion: registryEntry?.pendingReindexForVersion, attempt },
          'Lazy post-update reindex: giving up after repeated unfinished attempts — falling back to incremental index',
        );
        try {
          clearPendingReindex(projectRoot);
        } catch {
          /* non-fatal — worst case we retry the cap check next boot */
        }
      } else {
        logger.info(
          { projectRoot, forVersion: registryEntry?.pendingReindexForVersion, attempt },
          'Lazy post-update reindex: forcing full index rebuild for this project',
        );
      }
    }
    managed.initialIndexPromise = this.indexAllLimit!(() => pipeline.indexAll(needsForcedReindex))
      .then(async () => {
        managed.status = 'ready';
        updateLastIndexed(projectRoot);
        if (needsForcedReindex) {
          try {
            clearPendingReindex(projectRoot);
          } catch (err) {
            logger.warn(
              { projectRoot, err: String(err) },
              'Lazy post-update reindex: clearing flag failed (non-fatal)',
            );
          }
        }
        runSummarization(aiAbortController.signal);
        runEmbeddings(aiAbortController.signal);
        await runSubprojectAutoSync(projectRoot, config);
        logger.info({ projectRoot }, 'Project indexing complete');
      })
      .catch(async (err) => {
        if (isForeignKeyError(err)) {
          logger.warn(
            { projectRoot, error: String(err) },
            'Initial indexing hit FOREIGN KEY violation — likely stale data from older schema. Retrying with force=true.',
          );
          const finishRecovery = async (via: string): Promise<void> => {
            managed.status = 'ready';
            updateLastIndexed(projectRoot);
            if (needsForcedReindex) {
              try {
                clearPendingReindex(projectRoot);
              } catch {
                /* non-fatal — flag will retry next startup */
              }
            }
            runSummarization();
            runEmbeddings();
            await runSubprojectAutoSync(projectRoot, config);
            logger.info({ projectRoot }, `Project indexing complete (${via})`);
          };
          try {
            await this.indexAllLimit!(() => pipeline.indexAll(true));
            await finishRecovery('force-reindex recovery');
            return;
          } catch (retryErr) {
            // The in-place force-reindex retry re-ran against the wedged rows
            // with foreign_keys = ON (the DB was non-empty, so it never entered
            // bulk-load mode) and hit the same violation. If this is still a FK
            // error, escalate ONCE to a hard table reset: wipe the graph tables
            // in place so the follow-up run starts from an empty index, enters
            // bulk-load mode (foreign_keys = OFF) and rebuilds cleanly — the
            // programmatic equivalent of deleting + rebuilding the index DB
            // file, but without closing the shared handle. Any non-FK failure,
            // or a failure that survives the hard reset, is terminal: we set an
            // error status and stop. There is no third attempt, so recovery can
            // never loop.
            if (!isForeignKeyError(retryErr)) {
              managed.status = 'error';
              managed.error = `Force-reindex after FK recovery still failed: ${String(retryErr)}`;
              logger.error(
                { error: serializeError(retryErr), projectRoot, originalError: String(err) },
                'Force-reindex recovery also failed',
              );
              return;
            }
            logger.warn(
              { projectRoot, error: String(retryErr) },
              'In-place force-reindex still hit FOREIGN KEY violation — hard-resetting index tables and rebuilding from scratch.',
            );
            try {
              this.hardResetIndexTables(store);
              await this.indexAllLimit!(() => pipeline.indexAll(true));
              await finishRecovery('force-reindex recovery after hard reset');
              return;
            } catch (hardErr) {
              managed.status = 'error';
              managed.error = `Index rebuild after FK hard reset still failed: ${String(hardErr)}`;
              logger.error(
                {
                  error: serializeError(hardErr),
                  projectRoot,
                  originalError: String(err),
                  retryError: String(retryErr),
                },
                'FK hard-reset recovery also failed — giving up (no further retry)',
              );
              return;
            }
          }
        }
        managed.status = 'error';
        managed.error = String(err);
        logger.error({ error: serializeError(err), projectRoot }, 'Initial indexing failed');
      });

    // Start file watcher (skipped in read-mostly mode — see `watch` above).
    // Agent-driven edits still reindex via register_edit / the PostToolUse hook;
    // only external (IDE) edits go unnoticed until the next connect's indexAll.
    if (watch) {
      await watcher.start(
        projectRoot,
        config,
        async (paths) => {
          // A filesystem change is real activity too — keep the idle-unload
          // sweep from evicting a project that's being actively edited, even
          // if no MCP session is connected (e.g. IDE-only editing).
          managed.lastAccessedAt = Date.now();
          const watchStart = performance.now();
          const stats = getReindexStats();
          // Dedup against the recent-reindex cache: if the same Edit fired
          // both parcel-watcher and the PostToolUse hook (or register_edit),
          // the second arrival is a no-op. Compute a POSIX-relative key
          // matching the form used by reindex-file-handler.ts.
          const toRel = (p: string): string => {
            const rel = path.isAbsolute(p) ? path.relative(projectRoot, p) : p;
            return path.sep === '\\' ? rel.split('\\').join('/') : rel;
          };
          const skipped: string[] = [];
          const toIndex: string[] = [];
          for (const p of paths) {
            const rel = toRel(p);
            if (shouldSkipRecentReindex(projectRoot, rel)) {
              skipped.push(rel);
            } else {
              toIndex.push(p);
            }
          }
          for (const rel of skipped) {
            const elapsedMs = Math.round(performance.now() - watchStart);
            logger.info(
              {
                event: 'reindex-file',
                project: projectRoot,
                path: rel,
                pathSource: 'watcher',
                skippedRecent: true,
                skippedHash: false,
                indexed: 0,
                elapsedMs,
              },
              'reindex-file telemetry',
            );
            stats.record({
              pathSource: 'watcher',
              skippedRecent: true,
              skippedHash: false,
              indexed: 0,
              elapsedMs,
            });
          }
          if (toIndex.length === 0) return;

          let result: { indexed?: number; skipped?: number; changedFileIds?: number[] } | undefined;
          let watchErr: unknown;
          try {
            result = await pipeline.indexFiles(toIndex);
          } catch (err) {
            watchErr = err;
            throw err;
          } finally {
            const elapsedMs = Math.round(performance.now() - watchStart);
            const indexed = result?.indexed ?? 0;
            const skippedRows = result?.skipped ?? 0;
            const skippedHash = indexed === 0 && skippedRows > 0;
            for (const p of toIndex) {
              const relPosix = toRel(p);
              if (watchErr) {
                logger.error(
                  {
                    event: 'reindex-file',
                    project: projectRoot,
                    path: relPosix,
                    pathSource: 'watcher',
                    skippedRecent: false,
                    skippedHash: false,
                    indexed: 0,
                    elapsedMs,
                    err: watchErr,
                    error: String(watchErr),
                  },
                  'reindex-file telemetry (error)',
                );
                stats.record({
                  pathSource: 'watcher',
                  skippedRecent: false,
                  skippedHash: false,
                  indexed: 0,
                  elapsedMs,
                  error: true,
                });
              } else {
                logger.info(
                  {
                    event: 'reindex-file',
                    project: projectRoot,
                    path: relPosix,
                    pathSource: 'watcher',
                    skippedRecent: false,
                    skippedHash,
                    indexed,
                    elapsedMs,
                  },
                  'reindex-file telemetry',
                );
                stats.record({
                  pathSource: 'watcher',
                  skippedRecent: false,
                  skippedHash,
                  indexed,
                  elapsedMs,
                });
              }
            }
          }
          debouncedSummarize();
          debouncedEmbed();
          // Phase 3: schedule scoped LSP enrichment off the hot path. Only
          // fires when LSP is enabled in config (lspEnricher is null
          // otherwise) and only for IDs the pipeline actually touched.
          if (lspEnricher && result?.changedFileIds && result.changedFileIds.length > 0) {
            lspEnricher.scheduleEnrichment(result.changedFileIds);
          }
        },
        undefined,
        async (deleted) => {
          pipeline.deleteFiles(deleted);
        },
        {
          descendantExcludeGlobs: descendantExcludeGlobs(projectRoot),
          // Dropped fs events (bulk checkout, install, wake from sleep) leave
          // the index silently stale. indexAll() re-walks the root and is
          // hash-gated, so unchanged files cost a stat+hash, not a reparse.
          onRescan: async () => {
            await pipeline.indexAll();
          },
        },
      );
    }

    // A registered ancestor of this new project already has a live watcher
    // whose ignore list was snapshotted before this project existed — it is
    // now stale and would double-watch/double-index everything under
    // `projectRoot` until restarted. Recompute and restart in place (only
    // for ancestors this daemon actually manages in-memory; an ancestor that
    // was never addProject()'d has nothing to restart). Gated on `persist`
    // alone: that's what controls registry membership (setupProject() above)
    // and thus what descendantExcludeGlobs() reports for `projectRoot` — a
    // project can be registered (persist: true) without this call starting a
    // live watcher for it (watch: false), and the ancestor still needs to
    // exclude that subtree either way.
    if (persist) {
      await this.restartManagedAncestorWatchers(projectRoot);
    }

    logger.info({ projectRoot, watch, persist }, 'Project added to daemon');
    return managed;
  }

  /**
   * Restart the watcher of every currently-managed project whose root is a
   * strict ancestor of `changedRoot`, recomputing descendantExcludeGlobs()
   * so the ancestor's ignore list picks up `changedRoot` having just been
   * registered (addProject) or unregistered (removeProject). Cheap and rare:
   * this only runs on registration changes, never on the watcher's hot path.
   */
  private async restartManagedAncestorWatchers(changedRoot: string): Promise<void> {
    for (const managed of this.projects.values()) {
      if (managed.root === changedRoot) continue;
      const rel = path.relative(managed.root, changedRoot);
      const isStrictAncestor = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
      if (!isStrictAncestor) continue;
      try {
        await managed.watcher.restartWithExcludes(descendantExcludeGlobs(managed.root));
        logger.info(
          { ancestor: managed.root, changedRoot },
          'Restarted ancestor watcher with recomputed descendant excludes',
        );
      } catch (err) {
        logger.warn(
          { error: err, ancestor: managed.root, changedRoot },
          'Failed to restart ancestor watcher after registration change (non-fatal — ' +
            'excludes will still be recomputed on next daemon restart via loadAllRegistered)',
        );
      }
    }
  }

  /**
   * FK-recovery hard reset. Wipes every graph/data table on the project's
   * INDEX database in place, leaving the schema, seed rows (node_types,
   * edge_types), version tracking (schema_meta, schema_migrations) and the
   * server PID row intact. After this returns the index is genuinely empty
   * (`symbols` has 0 rows), so the follow-up `indexAll(true)` re-enters
   * bulk-load mode — which sets `foreign_keys = OFF` — and rebuilds the graph
   * from scratch instead of colliding with the stale rows that wedged the
   * in-place force-reindex.
   *
   * Why in-place rather than close → delete file → reopen: the project's
   * `store`, `pipeline`, `serverHandle`, watcher callbacks and AI pipelines
   * all capture THIS exact `Store`/`Database` handle by closure. Swapping the
   * on-disk file would require re-wiring every one of them and would race the
   * live watcher. Clearing the tables on the shared handle keeps all wiring
   * valid and needs no lock coordination beyond the pipeline's own `_lock`
   * (held by the caller, which awaits the failed `indexAll` before calling us).
   *
   * SCOPE: this touches ONLY the index DB reachable via `store.db`. The
   * decisions.db and topology.db handles live in a separate resource pool and
   * are never opened here — the FK error is always thrown inside an index
   * write transaction, so the index DB is the only database to rebuild.
   *
   * Idempotent and drift-proof: the table list is enumerated from
   * `sqlite_master` at runtime rather than hard-coded, so a future migration
   * that adds a table is cleared automatically. FTS5 virtual + shadow tables
   * are skipped — they are content-external mirrors of `symbols` and stay
   * consistent through the `symbols_ad` delete trigger.
   */
  private hardResetIndexTables(store: Store): void {
    const db = store.db;
    // Tables that must survive the wipe: seed/reference data the schema
    // depends on, version tracking, and the daemon PID lock row.
    const PRESERVE = new Set([
      'node_types',
      'edge_types',
      'schema_meta',
      'schema_migrations',
      'server_state',
    ]);
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name NOT LIKE '%_fts'
           AND name NOT LIKE '%_fts_%'`,
      )
      .all() as Array<{ name: string }>;
    const targets = rows.map((r) => r.name).filter((name) => !PRESERVE.has(name));

    // FK enforcement OFF for the duration of the wipe so we can clear tables in
    // any order without tripping the very constraint we are recovering from.
    // Restored to ON in the finally block regardless of outcome — leaving a
    // live daemon handle with FK OFF would silently mask real violations.
    db.pragma('foreign_keys = OFF');
    try {
      const wipe = db.transaction(() => {
        for (const name of targets) {
          db.exec(`DELETE FROM "${name}"`);
        }
      });
      wipe();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    // Flush the WAL so the empty state is durable in the main DB file and the
    // next reader/opener doesn't inherit a bloated WAL from the wipe.
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      logger.debug({ err }, 'wal_checkpoint after FK hard reset failed (non-fatal)');
    }
  }

  /**
   * Tear down in-memory state for a project (watcher, server, DB) without
   * touching the on-disk registry. Used by both `shutdown()` (graceful
   * daemon restart) and `removeProject()` (explicit user removal).
   */
  private async stopProject(root: string): Promise<void> {
    const managed = this.projects.get(root);
    if (!managed) return;
    // Signal every background producer synchronously, before the first await:
    // abort in-flight AI fetches so a long-running summarize batch cannot
    // return after the DB has closed and write into stale references, and
    // cancel the LSP enricher so its run aborts via its AbortSignal. These are
    // non-blocking, so nothing below can starve them.
    managed.aiAbortController?.abort();
    managed.cancelDebouncedAI?.();
    try {
      managed.lspEnricher?.cancel();
    } catch (err) {
      logger.warn(
        { error: err, projectRoot: root },
        'lspEnricher.cancel() failed during stopProject (non-fatal)',
      );
    }
    // Then unsubscribe the file watcher and drain its in-flight handler BEFORE
    // the waits below (TRA-834). `await managed.initialIndexPromise` can run
    // for tens of seconds on a cold project, and a still-subscribed watcher
    // keeps firing debounced `onChanges` handlers throughout it — each one
    // starting a fresh indexing run against a Store that a sibling
    // stopProject() is closing. Field logs showed 12 "The database connection
    // is not open" failures, every one of them after "Daemon shutting down",
    // one project logging five of them over 27 seconds. Stopping the source of
    // new work first is what makes the teardown below finite.
    await managed.watcher.stop();
    // A drained handler ends by re-arming debouncedSummarize/debouncedEmbed and
    // scheduling LSP enrichment (see the onChanges tail in addProject), and
    // `trailingDebounce` mints a fresh AbortController when it is scheduled
    // after a cancel — so the cancels above no longer cover those timers. Cancel
    // once more now that no handler is left to arm another one.
    managed.cancelDebouncedAI?.();
    try {
      managed.lspEnricher?.cancel();
    } catch (err) {
      logger.warn(
        { error: err, projectRoot: root },
        'lspEnricher.cancel() failed during stopProject (non-fatal)',
      );
    }
    // Wait for the background initial-index chain (indexAll → summarize/embed →
    // subproject auto-sync) to finish so its topology.db handle is closed
    // before we tear down this project — see initialIndexPromise's doc comment.
    try {
      await managed.initialIndexPromise;
    } catch (err) {
      logger.warn(
        { error: err, projectRoot: root },
        'initialIndexPromise rejected during stopProject (non-fatal)',
      );
    }
    clearServerPid(managed.db);
    managed.serverHandle.dispose();
    await managed.server.close();
    // Dispose the pipeline before the DB closes. With an injected SQLite task
    // cache the dispose call is mostly a no-op (the cache belongs to `db`),
    // but for any per-pipeline in-memory state the call drops references so
    // the heap can shrink between project lifecycles.
    try {
      await managed.pipeline.dispose();
    } catch (err) {
      logger.warn(
        { error: err, projectRoot: root },
        'pipeline.dispose() failed during stopProject',
      );
    }
    managed.db.close();
    // TRA-304: we no longer hold this DB, so a sibling checkout of the same
    // git remote is free to share it again on its next registration.
    releaseDbHoldersForRoot(root);
    this.projects.delete(root);
    clearProjectReindexCache(root);
    // Evict per-project caches living inside the shared worker pool
    // (FileExtractor + parsed ProjectContext keyed by rootPath). The pool
    // itself stays warm; only the now-stale per-project entries are dropped.
    // The pipeline's rootPath matches the `root` key — workers see this
    // exact string in `req.rootPath`.
    try {
      this.sharedPool?.dropProject(root);
    } catch (err) {
      logger.warn({ error: err, projectRoot: root }, 'sharedPool.dropProject failed (non-fatal)');
    }
    // Force-dispose the per-project entry in the resource pool (TopologyStore
    // + DecisionStore SQLite handles). stopProject runs unconditionally — we
    // don't wait for refCount to drain because by this point the project is
    // gone from `projects` and no new sessions can be acquired for this root.
    // Any in-flight session.onclose handler will see a stale entry but its
    // release() call is a no-op (entry already deleted).
    try {
      this.resourcePool?.disposeProject(root);
    } catch (err) {
      logger.warn(
        { error: err, projectRoot: root },
        'resourcePool.disposeProject failed (non-fatal)',
      );
    }
  }

  /**
   * Stop a project, delete its on-disk artifacts, and drop it from the
   * persistent registry.
   *
   * `keepDbFiles: true` skips the index/session/task-cache DB unlinks but
   * still drops topology + decision rows + registry entry. Default is
   * `false` — desktop "delete project" should reclaim disk.
   *
   * Artifact cleanup is best-effort and idempotent: a partial failure on one
   * tier (e.g. topology DB locked by another process) does not block the
   * registry unregister, so the UI never lies about removal.
   */
  async removeProject(
    root: string,
    options?: RemoveArtifactsOptions,
  ): Promise<RemoveArtifactsResult> {
    await this.stopProject(root);
    let artifacts: RemoveArtifactsResult;
    try {
      artifacts = removeProjectArtifacts(root, options);
    } catch (err) {
      // Cleanup is best-effort — never block unregister on a stray fs error.
      logger.warn({ err, projectRoot: root }, 'removeProjectArtifacts threw (non-fatal)');
      artifacts = {
        deleted: [],
        kept: [],
        freedBytes: 0,
        topology: { subprojects: 0, services: 0 },
        decisions: { decisions: 0, chunks: 0, clusters: 0, memos: 0 },
        failures: [{ tier: 'artifacts', error: String(err) }],
      };
    }
    unregisterProject(root);
    // Mirror addProject(): a managed ancestor's watcher ignore list may have
    // been scoped around this now-unregistered root and would otherwise stay
    // stale (harmlessly over-excluding) until the next daemon restart.
    // Recompute so the ancestor resumes owning these now-orphaned files.
    await this.restartManagedAncestorWatchers(root);
    logger.info(
      {
        projectRoot: root,
        deletedFiles: artifacts.deleted.length,
        freedBytes: artifacts.freedBytes,
        failures: artifacts.failures,
      },
      'Project removed from daemon',
    );
    return artifacts;
  }

  /**
   * Deregister one-shot agent-run checkouts whose run finished more than
   * `ttlHours` ago, and reclaim their index DBs (TRA-335).
   *
   * `prune` can never reclaim these on its own: it reads "root directory still
   * exists" as liveness, and the runtimes that create these workdirs don't
   * delete them when a run ends. `lastIndexed` is no signal either — this
   * daemon keeps reindexing them forever, so they look permanently fresh. Age
   * since registration is the only honest clock for a directory whose whole
   * purpose was one run, which is what `findEphemeralProjects` measures.
   *
   * Same liveness guards as `unloadIdleProjects` for the loaded ones (never
   * touch a project mid-index or with connected clients), and `removeProject`
   * keeps the index DB whenever a sibling checkout still points at it or holds
   * it open. Unloaded candidates are removed directly — `stopProject` no-ops.
   *
   * ponytail: recognizing an ephemeral root is a path heuristic, so this only
   * covers the workdir shapes `findEphemeralProjects` knows. A per-project
   * last-*queried* timestamp would generalize to CI/worktrees/sandboxes; add
   * it when one of those actually shows up, not before.
   */
  async sweepEphemeralProjects(ttlHours = 72): Promise<string[]> {
    const removed: string[] = [];
    for (const candidate of findEphemeralProjects(ttlHours)) {
      const managed = this.projects.get(candidate.root);
      if (managed && (managed.status === 'starting' || managed.status === 'indexing')) continue;
      if ((this.resourcePool?.getRefCount(candidate.root) ?? 0) > 0) continue;
      logger.info(
        { projectRoot: candidate.root, ageHours: Math.round(candidate.ageHours) },
        'Deregistering stale one-shot workdir project',
      );
      await this.removeProject(candidate.root);
      removed.push(candidate.root);
    }
    return removed;
  }

  /** Get a managed project by root path. */
  getProject(root: string): ManagedProject | undefined {
    return this.projects.get(root);
  }

  /** Get all managed projects. */
  listProjects(): ManagedProject[] {
    return Array.from(this.projects.values());
  }

  /**
   * Record a request/watcher touch for `root`, resetting its idle-unload
   * clock. Call this at every point that routes work to a specific project
   * (session connect/close, REST reindex-file, watcher-driven reindex, etc —
   * mirrors the call sites of cli.ts's `pokeActivity`). No-op if the project
   * isn't currently loaded.
   */
  touchActivity(root: string): void {
    const managed = this.projects.get(root);
    if (managed) managed.lastAccessedAt = Date.now();
  }

  /**
   * Unload every currently-loaded project idle longer than `idleMs`, except:
   *  - a project still `starting`/`indexing` (unloading mid-index would abort
   *    real work, not reclaim idle memory);
   *  - a project with connected clients/SSE subscribers, per
   *    `resourcePool.getRefCount(root) > 0` — the same client-tracking
   *    `daemon_idle_exit_minutes` relies on, scoped per-project.
   *
   * Unloading calls the same in-memory teardown as `removeProject()`
   * (`stopProject`) WITHOUT touching the on-disk registry, so the project
   * stays listed and is re-added lazily the next time a request for its root
   * arrives (existing `addProject()` cold-start path — 503 + Retry-After
   * while it warms, see cli.ts serve-http Phase 5.1).
   *
   * `maxLoaded > 0` additionally enforces a hard ceiling on how many projects
   * stay resident: anything above it is evicted least-recently-accessed first,
   * regardless of `idleMs`. Without this, `daemon_eager_load_projects` was a
   * startup budget only — lazy loads walked straight past it (TRA-422: an
   * eager-8 daemon sat at 11 loaded projects three minutes after boot, and at
   * a measured ~100 MB resident per loaded project that is ~300 MB nobody
   * capped). Same exemptions as the TTL path apply, so a busy or indexing
   * project is never evicted just to satisfy the ceiling.
   *
   * Returns the roots that were unloaded (mainly for tests/telemetry).
   */
  async unloadIdleProjects(idleMs: number, maxLoaded = 0): Promise<string[]> {
    if (idleMs <= 0 && maxLoaded <= 0) return [];
    const now = Date.now();
    const evictable: ManagedProject[] = [];
    for (const managed of this.projects.values()) {
      if (managed.status === 'starting' || managed.status === 'indexing') continue;
      if ((this.resourcePool?.getRefCount(managed.root) ?? 0) > 0) continue;
      evictable.push(managed);
    }
    const candidates = new Set<string>();
    if (idleMs > 0) {
      for (const managed of evictable) {
        if (now - managed.lastAccessedAt >= idleMs) candidates.add(managed.root);
      }
    }
    if (maxLoaded > 0 && this.projects.size > maxLoaded) {
      const overBy = this.projects.size - maxLoaded;
      const lruFirst = [...evictable].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
      for (const managed of lruFirst) {
        if (candidates.size >= overBy) break;
        candidates.add(managed.root);
      }
    }
    for (const root of candidates) {
      logger.info(
        { projectRoot: root, idleMs, maxLoaded },
        'Unloading idle project (stays registered)',
      );
      await this.stopProject(root);
    }
    return [...candidates];
  }

  /**
   * Start the periodic idle-unload sweep. `intervalMs` defaults to 5 minutes
   * per the design; `idleMs` is `project_idle_unload_minutes * 60_000` (0
   * disables the TTL rule). `opts.maxLoaded` is the LRU ceiling
   * (`daemon_eager_load_projects`, 0 = unlimited). No timer is armed when both
   * are off. Idempotent: calling twice replaces the previous timer. The
   * interval is unref'd so it never keeps the daemon process alive on its own.
   *
   * `onUnloaded` fires after each sweep tick that unloaded at least one
   * project — cli.ts uses it to tear down its per-project bookkeeping
   * (progress listener etc.), which would otherwise pin the unloaded
   * project's ProgressState for the daemon's lifetime.
   */
  startIdleUnloadSweep(
    idleMs: number,
    opts?: { intervalMs?: number; maxLoaded?: number; onUnloaded?: (roots: string[]) => void },
  ): void {
    this.stopIdleUnloadSweep();
    const maxLoaded = opts?.maxLoaded ?? 0;
    if (idleMs <= 0 && maxLoaded <= 0) return;
    this.idleUnloadTimer = setInterval(
      () => {
        this.unloadIdleProjects(idleMs, maxLoaded)
          .then((roots) => {
            if (roots.length > 0) opts?.onUnloaded?.(roots);
          })
          .catch((err) => {
            logger.warn({ err: serializeError(err) }, 'Idle-unload sweep failed (non-fatal)');
          });
      },
      opts?.intervalMs ?? 5 * 60_000,
    );
    this.idleUnloadTimer.unref?.();
  }

  /** Stop the periodic idle-unload sweep, if running. Safe to call when not running. */
  stopIdleUnloadSweep(): void {
    if (this.idleUnloadTimer) {
      clearInterval(this.idleUnloadTimer);
      this.idleUnloadTimer = null;
    }
  }

  /**
   * Shut down all projects in-memory. Does NOT unregister from the on-disk
   * registry — the daemon may be restarting (e.g. version-mismatch respawn,
   * supervisor relaunch) and must not lose the user's project list.
   */
  async shutdown(): Promise<void> {
    this.stopIdleUnloadSweep();
    const roots = Array.from(this.projects.keys());
    await Promise.all(roots.map((root) => this.stopProject(root)));
    if (this.sharedPool) {
      await this.sharedPool.terminate();
      this.sharedPool = null;
    }
    this.indexAllLimit = null;
    logger.info('ProjectManager shutdown complete');
  }

  /** Load all registered projects and start them. */
  async loadAllRegistered(): Promise<void> {
    const allEntries = listProjects();
    // Self-heal: evict registry rows that would block startup or cause
    // "Project not found" 404s at runtime:
    //  - dangerous roots (/, $HOME, system dirs) — typically from an MCP client
    //    that spawned trace-mcp with cwd=/, which would walk the entire FS.
    //  - missing folders whose parent still exists — the project was deleted.
    //    The parent-exists check spares projects on unmounted volumes (e.g.
    //    /Volumes/USB/foo when /Volumes/USB itself is also gone): we only
    //    prune when the immediate parent directory is still there, which is
    //    the signature of a user deletion vs. a transient mount.
    const entries = [];
    for (const entry of allEntries) {
      const dangerReason = isDangerousProjectRoot(entry.root);
      if (dangerReason) {
        logger.warn(
          { root: entry.root, reason: dangerReason },
          'Removing dangerous project from registry',
        );
        unregisterProject(entry.root);
        continue;
      }
      if (!fs.existsSync(entry.root) && fs.existsSync(path.dirname(entry.root))) {
        logger.warn(
          { root: entry.root },
          'Removing project with missing folder from registry (parent dir exists — looks like deletion, not unmount)',
        );
        unregisterProject(entry.root);
        continue;
      }
      entries.push(entry);
    }
    // Overlapping roots (a container folder registered alongside projects
    // inside it) double-index and double-watch the same files — observed in
    // the field as a 2-3× multiplier on every watcher-driven reindex. The
    // daemon still loads them (user's choice), but says so loudly; doctor
    // reports the same pairs with a fix hint.
    for (const o of findOverlappingProjects()) {
      logger.warn(
        { ancestor: o.ancestor.root, descendant: o.descendant.root },
        'Registered project roots overlap — same files are indexed and watched twice. ' +
          'Keep the per-project registrations and `trace-mcp remove` the container root.',
      );
    }
    // TRA-278: loading every registered project costs ~9 MB of live heap each
    // before any code is indexed, so a machine with ~100 registered repos paid
    // multi-GB RSS at every daemon start. Load only the most recently indexed
    // ones; the rest load lazily on first request (same path as idle-unload).
    const cap = loadGlobalConfigRaw().daemon_eager_load_projects;
    const { eager, deferred } = selectEagerLoadRoots(entries, typeof cap === 'number' ? cap : 8);
    if (deferred.length > 0) {
      logger.info(
        { eager: eager.length, deferred: deferred.length },
        'Deferring cold registered projects to lazy load (daemon_eager_load_projects)',
      );
    }
    // Phase 5+7 audit fix: addProject() runs synchronous setup (DB open, plugin
    // registry, watcher start, ~250-500ms each) BEFORE reaching the
    // semaphore-gated indexAll(). Without a gate, N parallel addProject() calls
    // produce a thundering herd of disk I/O at boot. Cap parallel setup at 2.
    const addLimit = pLimit(2);
    const results = await Promise.allSettled(
      eager.map((entry) => addLimit(() => this.addProject(entry.root))),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        // serializeError extracts message/stack/code from the raw Error.
        // Without it, an Error instance under a non-`err` key gets
        // JSON.stringify'd, dropping the non-enumerable `.message` — and the
        // SQLite error text we actually need for triage is lost.
        const reason = (results[i] as PromiseRejectedResult).reason;
        logger.error(
          {
            projectRoot: eager[i].root,
            dbPath: getDbPath(eager[i].root),
            error: serializeError(reason),
          },
          'Failed to load registered project',
        );
      }
    }
    logger.info(
      { count: this.projects.size, total: entries.length, deferred: deferred.length },
      'Loaded registered projects',
    );
  }
}
