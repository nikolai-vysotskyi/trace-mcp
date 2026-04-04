/**
 * Shared project setup logic — used by both `serve` (multi-project) and `index` command.
 * Creates Store, PluginRegistry, IndexingPipeline, and optionally AI pipelines.
 */

import type Database from 'better-sqlite3';
import { initializeDatabase } from './db/schema.js';
import { Store } from './db/store.js';
import { PluginRegistry } from './plugin-api/registry.js';
import { createAllLanguagePlugins } from './indexer/plugins/language/all.js';
import { createAllIntegrationPlugins } from './indexer/plugins/integration/all.js';
import { IndexingPipeline } from './indexer/pipeline.js';
import { FileWatcher } from './indexer/watcher.js';
import { createAIProvider, BlobVectorStore, EmbeddingPipeline, InferenceCache, CachedInferenceService } from './ai/index.js';
import { SummarizationPipeline } from './ai/summarization-pipeline.js';
import { logger } from './logger.js';
import type { TraceMcpConfig } from './config.js';

export interface ProjectInstance {
  root: string;
  db: Database.Database;
  store: Store;
  registry: PluginRegistry;
  pipeline: IndexingPipeline;
  config: TraceMcpConfig;
  watcher: FileWatcher | null;
  embeddingPipeline: EmbeddingPipeline | null;
  summarizationPipeline: SummarizationPipeline | null;
}

function registerDefaultPlugins(registry: PluginRegistry): void {
  for (const p of createAllLanguagePlugins()) registry.registerLanguagePlugin(p);
  for (const p of createAllIntegrationPlugins()) registry.registerFrameworkPlugin(p);
}

/** Create all project infrastructure. Does NOT start watcher or initial index. */
export function setupProject(projectRoot: string, dbPath: string, config: TraceMcpConfig): ProjectInstance {
  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  const registry = new PluginRegistry();
  registerDefaultPlugins(registry);

  const pipeline = new IndexingPipeline(store, registry, config, projectRoot);

  // AI pipelines
  const aiProvider = createAIProvider(config);
  const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
  const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
  const embeddingPipeline = vectorStore && embeddingService
    ? new EmbeddingPipeline(store, embeddingService, vectorStore)
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
        },
      )
    : null;

  return {
    root: projectRoot,
    db,
    store,
    registry,
    pipeline,
    config,
    watcher: null,
    embeddingPipeline,
    summarizationPipeline,
  };
}

/** Start file watching and initial indexing for a project instance. */
export async function startProjectWatcher(instance: ProjectInstance): Promise<void> {
  const watcher = new FileWatcher();

  const runEmbeddings = () => {
    if (!instance.embeddingPipeline) return;
    instance.embeddingPipeline.indexUnembedded().catch((err) => {
      logger.error({ error: err, project: instance.root }, 'Embedding indexing failed');
    });
  };

  const runSummarization = () => {
    if (!instance.summarizationPipeline) return;
    instance.summarizationPipeline.summarizeUnsummarized().catch((err) => {
      logger.error({ error: err, project: instance.root }, 'Summarization failed');
    });
  };

  // Initial index in background
  instance.pipeline.indexAll().then(() => {
    runSummarization();
    runEmbeddings();
  }).catch((err) => {
    logger.error({ error: err, project: instance.root }, 'Initial indexing failed');
  });

  await watcher.start(instance.root, instance.config, async (paths) => {
    await instance.pipeline.indexFiles(paths);
    runSummarization();
    runEmbeddings();
  }, undefined, async (deleted) => {
    instance.pipeline.deleteFiles(deleted);
  });

  instance.watcher = watcher;
  logger.info({ project: instance.root }, 'Project watcher started');
}

/** Stop watcher and close DB for a project instance. */
export async function stopProject(instance: ProjectInstance): Promise<void> {
  if (instance.watcher) {
    await instance.watcher.stop();
  }
  instance.db.close();
}
