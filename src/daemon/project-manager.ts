import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { PluginRegistry } from '../plugin-api/registry.js';
import { loadConfig } from '../config.js';
import type { TraceMcpConfig } from '../config.js';
import { createAllLanguagePlugins } from '../indexer/plugins/language/all.js';
import { createAllIntegrationPlugins } from '../indexer/plugins/integration/all.js';
import { IndexingPipeline } from '../indexer/pipeline.js';
import { FileWatcher } from '../indexer/watcher.js';
import { createAIProvider, BlobVectorStore, EmbeddingPipeline, InferenceCache, CachedInferenceService } from '../ai/index.js';
import { SummarizationPipeline } from '../ai/summarization-pipeline.js';
import { ProgressState, writeServerPid, clearServerPid } from '../progress.js';
import { createServer } from '../server/server.js';
import { logger } from '../logger.js';
import { getDbPath, ensureGlobalDirs } from '../global.js';
import { listProjects, getProject } from '../registry.js';
import { setupProject } from '../project-setup.js';
import { detectGitWorktree } from '../project-root.js';
import { TopologyStore } from '../topology/topology-db.js';
import { SubprojectManager } from '../subproject/manager.js';
import { TOPOLOGY_DB_PATH } from '../global.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';

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
  status: 'starting' | 'indexing' | 'ready' | 'error';
  error?: string;
}

function registerDefaultPlugins(registry: PluginRegistry): void {
  for (const p of createAllLanguagePlugins()) registry.registerLanguagePlugin(p);
  for (const p of createAllIntegrationPlugins()) registry.registerFrameworkPlugin(p);
}

function runSubprojectAutoSync(projectRoot: string, config: TraceMcpConfig): void {
  if (config.topology?.enabled === false) return;
  try {
    ensureGlobalDirs();
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    const dbPath = getDbPath(projectRoot);
    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const sm = new SubprojectManager(store, topoStore, projectRoot);
    sm.syncContracts();
    sm.syncClientCalls();
    db.close();
  } catch (err) {
    logger.warn({ error: err, projectRoot }, 'Subproject auto-sync failed (non-fatal)');
  }
}

export class ProjectManager {
  private projects = new Map<string, ManagedProject>();

  /** Set up and start indexing for a single project. */
  async addProject(projectRoot: string): Promise<ManagedProject> {
    const existing = this.projects.get(projectRoot);
    if (existing) return existing;

    const worktreeInfo = detectGitWorktree(projectRoot);
    const indexRoot = worktreeInfo?.mainRoot ?? projectRoot;

    if (worktreeInfo) {
      logger.info({ worktreeRoot: projectRoot, mainRoot: worktreeInfo.mainRoot }, 'Git worktree detected — sharing main repo index');
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
    const registry = new PluginRegistry();
    registerDefaultPlugins(registry);

    const progress = new ProgressState(db);
    const pipeline = new IndexingPipeline(store, registry, config, projectRoot, progress);
    const watcher = new FileWatcher();

    // AI pipelines (optional)
    const aiProvider = createAIProvider(config);
    const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
    const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
    const embeddingPipeline = vectorStore && embeddingService
      ? new EmbeddingPipeline(store, embeddingService, vectorStore, progress)
      : null;

    const inferenceCache = config.ai?.enabled ? new InferenceCache(store.db) : null;
    inferenceCache?.evictExpired();
    const summarizationPipeline = config.ai?.enabled && config.ai.summarize_on_index !== false
      ? new SummarizationPipeline(
          store,
          new CachedInferenceService(aiProvider.fastInference(), inferenceCache!, config.ai.fast_model ?? 'fast'),
          projectRoot,
          {
            batchSize: config.ai.summarize_batch_size ?? 20,
            kinds: config.ai.summarize_kinds ?? ['class', 'function', 'method', 'interface', 'trait', 'enum', 'type'],
            concurrency: config.ai.concurrency ?? 1,
          },
          progress,
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

    const server = createServer(store, registry, config, projectRoot, progress);

    const managed: ManagedProject = {
      root: projectRoot,
      config,
      db,
      store,
      registry,
      progress,
      pipeline,
      watcher,
      server,
      status: 'starting',
    };

    this.projects.set(projectRoot, managed);

    // Start indexing in background
    managed.status = 'indexing';
    pipeline.indexAll().then(() => {
      managed.status = 'ready';
      runSummarization();
      runEmbeddings();
      runSubprojectAutoSync(projectRoot, config);
      logger.info({ projectRoot }, 'Project indexing complete');
    }).catch((err) => {
      managed.status = 'error';
      managed.error = String(err);
      logger.error({ error: err, projectRoot }, 'Initial indexing failed');
    });

    // Start file watcher
    await watcher.start(projectRoot, config, async (paths) => {
      await pipeline.indexFiles(paths);
      runSummarization();
      runEmbeddings();
    }, undefined, async (deleted) => {
      pipeline.deleteFiles(deleted);
    });

    logger.info({ projectRoot }, 'Project added to daemon');
    return managed;
  }

  /** Stop watcher and close DB for a project. */
  async removeProject(root: string): Promise<void> {
    const managed = this.projects.get(root);
    if (!managed) return;

    await managed.watcher.stop();
    clearServerPid(managed.db);
    await managed.server.close();
    managed.db.close();
    this.projects.delete(root);
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

  /** Shut down all projects. */
  async shutdown(): Promise<void> {
    const roots = Array.from(this.projects.keys());
    await Promise.all(roots.map((root) => this.removeProject(root)));
    logger.info('ProjectManager shutdown complete');
  }

  /** Load all registered projects and start them. */
  async loadAllRegistered(): Promise<void> {
    const entries = listProjects();
    const results = await Promise.allSettled(
      entries.map((entry) => this.addProject(entry.root)),
    );
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
