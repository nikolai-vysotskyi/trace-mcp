import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import {
  BlobVectorStore,
  CachedInferenceService,
  createAIProvider,
  EmbeddingPipeline,
  InferenceCache,
} from '../../ai/index.js';
import { SummarizationPipeline } from '../../ai/summarization-pipeline.js';
import type { TraceMcpConfig } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { DECISIONS_DB_PATH, ensureGlobalDirs, TOPOLOGY_DB_PATH } from '../../global.js';
import { ExtractPool } from '../../indexer/extract-pool.js';
import { IndexingPipeline } from '../../indexer/pipeline.js';
import { FileWatcher } from '../../indexer/watcher.js';
import { logger } from '../../logger.js';
import { DecisionStore } from '../../memory/decision-store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { clearServerPid, ProgressState, writeServerPid } from '../../progress.js';
import { createServer, type ServerHandle } from '../../server/server.js';
import { SubprojectManager } from '../../subproject/manager.js';
import { TopologyStore } from '../../topology/topology-db.js';
import { trailingDebounce } from '../../util/debounce.js';
import type { Backend } from './types.js';

const AI_COALESCE_WAIT_MS = 5_000;

export interface LocalBackendOptions {
  projectRoot: string; // absolute path watched/indexed
  indexRoot: string; // main repo root (differs from projectRoot in git worktrees)
  config: TraceMcpConfig;
  /** Shared DB path resolved by the caller (e.g. ~/.trace-mcp/index/project.db).
   *  LocalBackend will derive a unique session temp DB from this. */
  sharedDbPath: string;
}

/**
 * Full-mode backend: owns a complete in-process McpServer with its own DB, indexer,
 * watcher and (optional) AI pipelines. Talks to the Router via an InMemoryTransport
 * pair so the Router can swap backends without touching the McpServer lifecycle.
 *
 * Resource layout:
 *   stdin → Router → this.send() → clientSide.send() → serverSide.onmessage →
 *     McpServer → serverSide.send() → clientSide.onmessage → this.onmessage → stdout
 */
export class LocalBackend implements Backend {
  readonly kind = 'local' as const;

  onmessage?: (msg: JSONRPCMessage) => void;
  onerror?: (err: Error) => void;
  backgroundDispose?: Promise<void>;

  private readonly opts: LocalBackendOptions;
  private readonly dbPath: string;
  private db: Database.Database | null = null;
  private store: Store | null = null;
  private registry: PluginRegistry | null = null;
  private progress: ProgressState | null = null;
  private pipeline: IndexingPipeline | null = null;
  private watcher: FileWatcher | null = null;
  private extractPool: ExtractPool | null = null;
  private handle: ServerHandle | null = null;
  private topoStore: TopologyStore | null = null;
  private decisionStore: DecisionStore | null = null;
  private clientTransport: InMemoryTransport | null = null;
  private indexingPromise: Promise<void> | null = null;
  private started = false;
  private stopping = false;
  private cancelDebouncedAI: (() => void) | null = null;

  constructor(opts: LocalBackendOptions) {
    this.opts = opts;
    this.dbPath = opts.sharedDbPath.replace(/\.db$/, `-session-${randomUUID().slice(0, 8)}.db`);
  }

  async start(): Promise<void> {
    if (this.started) return;
    const { projectRoot, config } = this.opts;
    ensureGlobalDirs();

    // Build all full-mode resources up-front — cheap (~500ms) compared to indexing.
    this.db = initializeDatabase(this.dbPath);
    writeServerPid(this.db);
    this.store = new Store(this.db);
    this.registry = PluginRegistry.createWithDefaults();
    this.progress = new ProgressState(this.db);
    this.extractPool = new ExtractPool({
      keepAlive: true,
      size: config.indexer?.workers,
    });
    this.pipeline = new IndexingPipeline(
      this.store,
      this.registry,
      config,
      projectRoot,
      this.progress,
      { extractPool: this.extractPool },
    );
    this.watcher = new FileWatcher();

    const aiProvider = createAIProvider(config);
    const vectorStore = config.ai?.enabled ? new BlobVectorStore(this.store.db) : null;
    const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
    const embeddingPipeline =
      vectorStore && embeddingService
        ? new EmbeddingPipeline(this.store, embeddingService, vectorStore, this.progress)
        : null;

    const inferenceCache = config.ai?.enabled ? new InferenceCache(this.store.db) : null;
    inferenceCache?.evictExpired();
    const summarizationPipeline =
      config.ai?.enabled && config.ai.summarize_on_index !== false
        ? new SummarizationPipeline(
            this.store,
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
            this.progress,
            vectorStore,
          )
        : null;

    const runEmbeddings = () => {
      if (!embeddingPipeline) return;
      embeddingPipeline.indexUnembedded().catch((err) => {
        logger.error({ error: err }, 'LocalBackend: embedding indexing failed');
      });
    };
    const runSummarization = () => {
      if (!summarizationPipeline) return;
      summarizationPipeline.summarizeUnsummarized().catch((err) => {
        logger.error({ error: err }, 'LocalBackend: summarization failed');
      });
    };

    const debouncedSummarize = trailingDebounce(runSummarization, AI_COALESCE_WAIT_MS);
    const debouncedEmbed = trailingDebounce(runEmbeddings, AI_COALESCE_WAIT_MS);
    this.cancelDebouncedAI = () => {
      debouncedSummarize.cancel();
      debouncedEmbed.cancel();
    };

    // Kick off initial indexing in the background — do not block start.
    // This promise is tracked so stop() can let it drain before closing the DB.
    this.indexingPromise = this.pipeline
      .indexAll()
      .then(() => {
        if (this.stopping) return;
        runSummarization();
        runEmbeddings();
        runSubprojectAutoSyncSafe(projectRoot, config);
      })
      .catch((err) => {
        logger.error({ error: err }, 'LocalBackend: initial indexing failed');
      });

    // Readonly shared stores — may not exist yet.
    try {
      if (config.topology?.enabled && fs.existsSync(TOPOLOGY_DB_PATH)) {
        this.topoStore = new TopologyStore(TOPOLOGY_DB_PATH, { readonly: true });
      }
    } catch {
      /* noop */
    }
    try {
      if (fs.existsSync(DECISIONS_DB_PATH)) {
        this.decisionStore = new DecisionStore(DECISIONS_DB_PATH, { readonly: true });
      }
    } catch {
      /* noop */
    }

    // Start file watcher.
    await this.watcher.start(
      projectRoot,
      config,
      async (paths) => {
        if (this.stopping) return;
        await this.pipeline!.indexFiles(paths);
        debouncedSummarize();
        debouncedEmbed();
      },
      undefined,
      async (deleted) => {
        if (this.stopping) return;
        this.pipeline!.deleteFiles(deleted);
      },
    );

    // Create McpServer and wire it to our in-memory pair.
    this.handle = createServer(this.store, this.registry, config, projectRoot, this.progress, {
      topoStore: this.topoStore,
      decisionStore: this.decisionStore,
    });

    const [client, server] = InMemoryTransport.createLinkedPair();
    this.clientTransport = client;
    this.serverTransport = server;

    // Client-side (us) — forward server→client messages up to Router→stdout.
    client.onmessage = (msg) => {
      this.onmessage?.(msg);
    };
    client.onerror = (err) => {
      logger.warn({ err: String(err) }, 'LocalBackend: in-memory client error');
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    };

    // Server-side — McpServer will set its own onmessage when connected.
    await this.handle.server.connect(server);
    await client.start();

    this.started = true;
    logger.info({ dbPath: this.dbPath, projectRoot }, 'LocalBackend started');
  }

  async stop(): Promise<void> {
    if (this.stopping || !this.started) return;
    this.stopping = true;

    // Cancel any pending debounced AI fires so they don't run after stop.
    try {
      this.cancelDebouncedAI?.();
    } catch {
      /* best-effort */
    }
    this.cancelDebouncedAI = null;

    // Stop accepting new MCP messages immediately.
    // Detach our onmessage so router never receives stale output.
    if (this.clientTransport) this.clientTransport.onmessage = undefined;

    // Stop file watcher right away — no new incremental indexing jobs.
    try {
      await this.watcher?.stop();
    } catch {
      /* best-effort */
    }

    // Close the in-memory transport pair (stops McpServer from receiving/sending).
    try {
      await this.clientTransport?.close();
    } catch {
      /* best-effort */
    }
    this.clientTransport = null;
    this.serverTransport = null;

    // Dispose McpServer (flushes journal/session data).
    try {
      this.handle?.dispose();
    } catch {
      /* best-effort */
    }

    // Hand off heavy cleanup to the background: let any in-flight indexing
    // drain before we close the DB and delete the temp file. Session will
    // await backgroundDispose on process shutdown so nothing leaks.
    const pendingIndex = this.indexingPromise;
    this.backgroundDispose = (async () => {
      try {
        await pendingIndex;
      } catch {
        /* already logged */
      }
      try {
        if (this.topoStore) this.topoStore.close();
      } catch {
        /* best-effort */
      }
      try {
        if (this.decisionStore) this.decisionStore.close();
      } catch {
        /* best-effort */
      }
      try {
        if (this.extractPool) await this.extractPool.terminate();
      } catch {
        /* best-effort */
      }
      this.extractPool = null;
      try {
        if (this.db) clearServerPid(this.db);
      } catch {
        /* best-effort */
      }
      try {
        this.db?.close();
      } catch {
        /* best-effort */
      }
      // Delete session-specific temp DB and its WAL/SHM companions.
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(this.dbPath + suffix);
        } catch {
          /* may not exist */
        }
      }
      this.db = null;
      this.store = null;
      this.handle = null;
      this.pipeline = null;
      this.watcher = null;
      this.registry = null;
      this.progress = null;
      this.topoStore = null;
      this.decisionStore = null;
      logger.info({ dbPath: this.dbPath }, 'LocalBackend background dispose complete');
    })();

    this.started = false;
  }

  async send(msg: JSONRPCMessage): Promise<void> {
    if (!this.clientTransport) throw new Error('LocalBackend not started');
    await this.clientTransport.send(msg);
  }
}

/**
 * Subproject auto-sync. Safe to call on a worker thread of LocalBackend's
 * indexing pipeline — matches cli.ts's behavior (logs service counts).
 */
function runSubprojectAutoSyncSafe(projectRoot: string, config: TraceMcpConfig): void {
  if (config.topology?.enabled === false) return;
  if (config.topology?.auto_discover === false) return;
  try {
    ensureGlobalDirs();
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    const manager = new SubprojectManager(topoStore);
    const { services } = manager.autoDiscoverSubprojects(projectRoot, {
      contractPaths: config.topology?.contract_globs,
    });
    const subprojects = topoStore.getAllSubprojects();
    if (subprojects.length > 1) {
      const linked = topoStore.linkClientCallsToEndpoints();
      if (linked > 0) logger.info({ linked }, 'Subproject: linked additional client calls');
    }
    const totalEndpoints = services.reduce((sum, s) => sum + s.endpoints, 0);
    const totalClientCalls = services.reduce((sum, s) => sum + s.clientCalls, 0);
    logger.info(
      {
        project: projectRoot,
        subprojects: services.length,
        serviceNames: services.map((s) => s.name),
        endpoints: totalEndpoints,
        clientCalls: totalClientCalls,
      },
      'Subproject auto-sync completed',
    );
    topoStore.close();
  } catch (err) {
    logger.warn({ error: err, projectRoot }, 'Subproject auto-sync failed (non-fatal)');
  }
}
