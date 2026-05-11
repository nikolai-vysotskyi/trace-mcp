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
import { loadConfig } from '../config.js';
import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { ensureGlobalDirs, getDbPath, TOPOLOGY_DB_PATH } from '../global.js';
import { ExtractPool } from '../indexer/extract-pool.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import { clearProjectReindexCache } from '../indexer/recent-reindex-cache.js';
import { FileWatcher } from '../indexer/watcher.js';
import { logger } from '../logger.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { clearServerPid, ProgressState, writeServerPid } from '../progress.js';
import { detectGitWorktree } from '../project-root.js';
import { isDangerousProjectRoot, setupProject } from '../project-setup.js';
import { listProjects, unregisterProject } from '../registry.js';
import type { ServerHandle } from '../server/server.js';
import { createServer } from '../server/server.js';
import { SubprojectManager } from '../subproject/manager.js';
import { TopologyStore } from '../topology/topology-db.js';
import { trailingDebounce } from '../util/debounce.js';

const AI_COALESCE_WAIT_MS = 5_000;

export interface ManagedProject {
  root: string;
  config: TraceMcpConfig;
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
}

function runSubprojectAutoSync(projectRoot: string, config: TraceMcpConfig): void {
  if (config.topology?.enabled === false) return;
  if (config.topology?.auto_discover === false) return;
  try {
    ensureGlobalDirs();
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    const manager = new SubprojectManager(topoStore);
    manager.autoDiscoverSubprojects(projectRoot, {
      contractPaths: config.topology?.contract_globs,
    });
  } catch (err) {
    logger.warn({ error: err, projectRoot }, 'Subproject auto-sync failed (non-fatal)');
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
  async addProject(projectRoot: string): Promise<ManagedProject> {
    const existing = this.projects.get(projectRoot);
    if (existing) return existing;

    const worktreeInfo = detectGitWorktree(projectRoot);
    const indexRoot = worktreeInfo?.mainRoot ?? projectRoot;

    if (worktreeInfo) {
      logger.info(
        { worktreeRoot: projectRoot, mainRoot: worktreeInfo.mainRoot },
        'Git worktree detected — sharing main repo index',
      );
    }

    // Standard registration: detect, config, DB, registry
    setupProject(projectRoot);

    const configResult = await loadConfig(projectRoot);
    if (configResult.isErr()) {
      throw new Error(`Failed to load config for ${projectRoot}: ${configResult.error}`);
    }
    const config = configResult.value;

    const dbPath = getDbPath(indexRoot);
    ensureGlobalDirs();

    const db = initializeDatabase(dbPath);
    writeServerPid(db);
    const store = new Store(db);
    const registry = PluginRegistry.createWithDefaults();

    this.ensureShared(config);

    const progress = new ProgressState(db);
    const pipeline = new IndexingPipeline(store, registry, config, projectRoot, progress, {
      extractPool: this.sharedPool,
    });
    const watcher = new FileWatcher();

    // AI pipelines (optional)
    const aiProvider = createAIProvider(config);
    const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
    const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
    const embeddingPipeline =
      vectorStore && embeddingService
        ? new EmbeddingPipeline(store, embeddingService, vectorStore, progress)
        : null;

    const inferenceCache = config.ai?.enabled ? new InferenceCache(store.db) : null;
    inferenceCache?.evictExpired();
    const summarizationPipeline =
      config.ai?.enabled && config.ai.summarize_on_index !== false
        ? new SummarizationPipeline(
            store,
            new CachedInferenceService(
              aiProvider.fastInference(),
              inferenceCache!,
              config.ai.fast_model ?? 'fast',
            ),
            projectRoot,
            {
              batchSize: config.ai.summarize_batch_size ?? 20,
              kinds: config.ai.summarize_kinds ?? [
                'class',
                'function',
                'method',
                'interface',
                'trait',
                'enum',
                'type',
              ],
              concurrency: config.ai.concurrency ?? 1,
            },
            progress,
            vectorStore,
          )
        : null;

    const runEmbeddings = () => {
      if (!embeddingPipeline) return;
      embeddingPipeline.indexUnembedded().catch((err) => {
        logger.error({ error: err, projectRoot }, 'Embedding indexing failed');
      });
    };

    const runSummarization = () => {
      if (!summarizationPipeline) return;
      summarizationPipeline.summarizeUnsummarized().catch((err) => {
        logger.error({ error: err, projectRoot }, 'Summarization failed');
      });
    };

    const debouncedSummarize = trailingDebounce(runSummarization, AI_COALESCE_WAIT_MS);
    const debouncedEmbed = trailingDebounce(runEmbeddings, AI_COALESCE_WAIT_MS);

    const serverHandle = createServer(store, registry, config, projectRoot, progress);

    const managed: ManagedProject = {
      root: projectRoot,
      config,
      db,
      store,
      registry,
      progress,
      pipeline,
      watcher,
      server: serverHandle.server,
      serverHandle,
      status: 'starting',
      cancelDebouncedAI: () => {
        debouncedSummarize.cancel();
        debouncedEmbed.cancel();
      },
    };

    this.projects.set(projectRoot, managed);

    // Start indexing in background, gated by the shared semaphore so adding
    // N projects at once doesn't fan out to N concurrent indexAll runs.
    managed.status = 'indexing';
    this.indexAllLimit!(() => pipeline.indexAll())
      .then(() => {
        managed.status = 'ready';
        runSummarization();
        runEmbeddings();
        runSubprojectAutoSync(projectRoot, config);
        logger.info({ projectRoot }, 'Project indexing complete');
      })
      .catch((err) => {
        managed.status = 'error';
        managed.error = String(err);
        logger.error({ error: err, projectRoot }, 'Initial indexing failed');
      });

    // Start file watcher
    await watcher.start(
      projectRoot,
      config,
      async (paths) => {
        await pipeline.indexFiles(paths);
        debouncedSummarize();
        debouncedEmbed();
      },
      undefined,
      async (deleted) => {
        pipeline.deleteFiles(deleted);
      },
    );

    logger.info({ projectRoot }, 'Project added to daemon');
    return managed;
  }

  /**
   * Tear down in-memory state for a project (watcher, server, DB) without
   * touching the on-disk registry. Used by both `shutdown()` (graceful
   * daemon restart) and `removeProject()` (explicit user removal).
   */
  private async stopProject(root: string): Promise<void> {
    const managed = this.projects.get(root);
    if (!managed) return;
    managed.cancelDebouncedAI?.();
    await managed.watcher.stop();
    clearServerPid(managed.db);
    managed.serverHandle.dispose();
    await managed.server.close();
    managed.db.close();
    this.projects.delete(root);
    clearProjectReindexCache(root);
  }

  /** Stop a project AND drop it from the persistent registry. */
  async removeProject(root: string): Promise<void> {
    await this.stopProject(root);
    unregisterProject(root);
    logger.info({ projectRoot: root }, 'Project removed from daemon');
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
   * Shut down all projects in-memory. Does NOT unregister from the on-disk
   * registry — the daemon may be restarting (e.g. version-mismatch respawn,
   * supervisor relaunch) and must not lose the user's project list.
   */
  async shutdown(): Promise<void> {
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
    // Self-heal: evict any registry rows that point at dangerous roots (/, $HOME,
    // system dirs). These usually come from an MCP client that spawned trace-mcp
    // with cwd=/ — indexing them would walk the entire filesystem.
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
      entries.push(entry);
    }
    const results = await Promise.allSettled(entries.map((entry) => this.addProject(entry.root)));
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        logger.error(
          { projectRoot: entries[i].root, error: (results[i] as PromiseRejectedResult).reason },
          'Failed to load registered project',
        );
      }
    }
    logger.info({ count: this.projects.size, total: entries.length }, 'Loaded registered projects');
  }
}
