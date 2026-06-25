import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
import { shouldSkipRecentReindex } from '../../indexer/recent-reindex-cache.js';
import { FileWatcher } from '../../indexer/watcher.js';
import { logger } from '../../logger.js';
import { DecisionStore } from '../../memory/decision-store.js';
import { SqliteTaskCache } from '../../pipeline/index.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { clearServerPid, ProgressState, writeServerPid } from '../../progress.js';
import { createServer, type ServerHandle } from '../../server/server.js';
import { SubprojectManager } from '../../subproject/manager.js';
import { TopologyStore } from '../../topology/topology-db.js';
import { trailingDebounce } from '../../util/debounce.js';
import { BackgroundLspEnricher } from '../../lsp/background-enricher.js';
import { serializeError } from '../log-error.js';
import { getReindexStats } from '../reindex-stats.js';
import { seedSessionDbFromShared, sweepOrphanedSessionDbs } from './session-db.js';
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
  /**
   * Read-only fallback: when the daemon already indexed this project and seeded
   * our session DB, we serve that snapshot directly and never run the indexing
   * stack (ExtractPool workers, indexAll, FileWatcher, AI passes). That stack is
   * what made each local-mode session cost ~0.4-1.3 GB; with N stdio sessions
   * during a daemon hiccup it piled up into multi-GB pressure that starved the
   * daemon further (#209). The daemon owns indexing; a fallback client only
   * needs to answer reads from the last index, and freshness returns when the
   * DaemonWatcher swaps it back to proxy. Full local indexing still runs in the
   * genuine daemonless case (no shared DB to seed from).
   */
  private readOnly = false;
  private started = false;
  private starting: Promise<void> | null = null;
  private stopping = false;
  private cancelDebouncedAI: (() => void) | null = null;
  /**
   * Phase 3 background LSP enricher. Constructed only when LSP is enabled
   * in config. Cancelled in stop() so any in-flight enrichment aborts
   * before the DB closes.
   */
  private lspEnricher: BackgroundLspEnricher | null = null;

  constructor(opts: LocalBackendOptions) {
    this.opts = opts;
    this.dbPath = opts.sharedDbPath.replace(/\.db$/, `-session-${randomUUID().slice(0, 8)}.db`);
  }

  async start(): Promise<void> {
    // Re-entry guard:
    //   - already finished starting → no-op (idempotent).
    //   - currently starting → return the in-flight promise so a second
    //     concurrent caller doesn't run init() twice and clobber fields.
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const { projectRoot, config } = this.opts;
    ensureGlobalDirs();

    // Reclaim session DBs leaked by SIGKILLed siblings (graceful dispose
    // unlinks them; killed processes don't). PID-liveness guarded — live
    // sessions are never touched. Best-effort and cheap (~ms per file).
    try {
      sweepOrphanedSessionDbs(path.dirname(this.dbPath));
    } catch {
      /* never block startup on janitorial work */
    }

    // Seed this session's DB from the canonical project DB (when one
    // exists) so the initial indexAll() below is a hash-gated validation
    // pass instead of a full from-scratch index. N stdio sessions during a
    // daemon outage used to mean N complete re-indexes of the same repo.
    const seeded = await seedSessionDbFromShared(this.opts.sharedDbPath, this.dbPath);
    if (seeded) {
      logger.info(
        { sharedDbPath: this.opts.sharedDbPath, sessionDbPath: this.dbPath },
        'Session DB seeded from shared project DB',
      );
    }

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
    // Daemon-style long-lived process: use the SQLite-backed task cache so
    // pass outputs persist on disk rather than accumulating in resident set.
    this.pipeline = new IndexingPipeline(
      this.store,
      this.registry,
      config,
      projectRoot,
      this.progress,
      { extractPool: this.extractPool, taskCache: new SqliteTaskCache(this.db) },
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
              summarizeFromDocstrings: config.ai.summarizeFromDocstrings,
            },
            this.progress,
            vectorStore,
          )
        : null;

    const runEmbeddings = () => {
      if (!embeddingPipeline) return;
      embeddingPipeline.indexUnembedded().catch((err) => {
        logger.error({ error: serializeError(err) }, 'LocalBackend: embedding indexing failed');
      });
    };
    const runSummarization = () => {
      if (!summarizationPipeline) return;
      summarizationPipeline.summarizeUnsummarized().catch((err) => {
        logger.error({ error: serializeError(err) }, 'LocalBackend: summarization failed');
      });
    };

    const debouncedSummarize = trailingDebounce(runSummarization, AI_COALESCE_WAIT_MS);
    const debouncedEmbed = trailingDebounce(runEmbeddings, AI_COALESCE_WAIT_MS);
    this.cancelDebouncedAI = () => {
      debouncedSummarize.cancel();
      debouncedEmbed.cancel();
    };

    // Phase 3 background LSP enricher — only constructed when LSP is enabled
    // in config (opt-in by design). Watcher onChanges schedules scoped
    // enrichment off the hot path; stop() cancels any in-flight run.
    if (config.lsp?.enabled) {
      this.lspEnricher = new BackgroundLspEnricher({
        store: this.store,
        config,
        rootPath: projectRoot,
      });
    }

    // Read-only fallback (the common case during a daemon hiccup): the seeded
    // DB already holds the daemon's index, so skip the entire indexing stack —
    // no indexAll (which spawns the ExtractPool worker threads), no AI passes.
    // Full indexing only runs in the genuine daemonless case (nothing seeded).
    const readOnly = seeded;
    this.readOnly = readOnly;

    // Kick off initial indexing in the background — do not block start.
    // This promise is tracked so stop() can let it drain before closing the DB.
    if (!readOnly) {
      this.indexingPromise = this.pipeline
        .indexAll()
        .then(async () => {
          if (this.stopping) return;
          runSummarization();
          runEmbeddings();
          await runSubprojectAutoSyncSafe(projectRoot, config);
        })
        .catch((err) => {
          logger.error({ error: serializeError(err) }, 'LocalBackend: initial indexing failed');
        });
    } else {
      logger.info(
        { dbPath: this.dbPath, projectRoot },
        'LocalBackend: read-only fallback — serving daemon-indexed snapshot, indexing stack idle',
      );
    }

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

    // Start file watcher — skipped in read-only fallback. The daemon owns
    // indexing; a fallback client serving the seeded snapshot must not spin up
    // @parcel/watcher + per-change reindexing (the `if` guards the whole
    // single `await this.watcher.start(...)` statement below).
    if (!readOnly)
      await this.watcher.start(
        projectRoot,
        config,
        async (paths) => {
          if (this.stopping) return;
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
            result = await this.pipeline!.indexFiles(toIndex);
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
          // fires when LSP is enabled in config (this.lspEnricher is null
          // otherwise) and only for IDs the pipeline actually touched.
          if (this.lspEnricher && result?.changedFileIds && result.changedFileIds.length > 0) {
            this.lspEnricher.scheduleEnrichment(result.changedFileIds);
          }
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

    // Cancel background LSP enricher BEFORE closing the in-flight indexing /
    // DB so any in-flight enrichment aborts via its AbortSignal and won't
    // try to write into a disposed Store.
    try {
      this.lspEnricher?.cancel();
    } catch {
      /* best-effort */
    }
    this.lspEnricher = null;

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
        // Dispose the pipeline before the DB closes. With an injected SQLite
        // task cache this is mostly a no-op, but it drops any per-pipeline
        // in-memory references so the heap can shrink between sessions.
        if (this.pipeline) await this.pipeline.dispose();
      } catch (err) {
        logger.warn({ error: err }, 'pipeline.dispose() failed during LocalBackend stop');
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
async function runSubprojectAutoSyncSafe(
  projectRoot: string,
  config: TraceMcpConfig,
): Promise<void> {
  if (config.topology?.enabled === false) return;
  if (config.topology?.auto_discover === false) return;
  try {
    ensureGlobalDirs();
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    const manager = new SubprojectManager(topoStore);
    const { services } = await manager.autoDiscoverSubprojects(projectRoot, {
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
