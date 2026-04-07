#!/usr/bin/env node

import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
declare const PKG_VERSION_INJECTED: string;
const PKG_VERSION = typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { initializeDatabase } from './db/schema.js';
import { Store } from './db/store.js';
import { PluginRegistry } from './plugin-api/registry.js';
import { loadConfig } from './config.js';
import { createServer } from './server/server.js';
import { logger, attachFileLogging } from './logger.js';
import { createAllLanguagePlugins } from './indexer/plugins/language/all.js';
import { createAllIntegrationPlugins } from './indexer/plugins/integration/all.js';
import { IndexingPipeline } from './indexer/pipeline.js';
import { FileWatcher } from './indexer/watcher.js';
import { createAIProvider, BlobVectorStore, EmbeddingPipeline, InferenceCache, CachedInferenceService } from './ai/index.js';
import { SummarizationPipeline } from './ai/summarization-pipeline.js';
import { ProgressState, writeServerPid, clearServerPid } from './progress.js';
import http from 'node:http';
import { initCommand } from './cli/init.js';
import { upgradeCommand } from './cli/upgrade.js';
import { addCommand } from './cli/add.js';
import { doctorCommand } from './cli/doctor.js';
import { ciReportCommand } from './cli/ci.js';
import { checkCommand } from './cli/check.js';
import { bundlesCommand } from './cli/bundles.js';
import { federationCommand } from './cli/federation.js';
import { analyticsCommand } from './cli/analytics.js';
import { removeCommand } from './cli/remove.js';
import { statusCommand } from './cli/status.js';
import { installGuardHook, uninstallGuardHook } from './init/hooks.js';
import { getDbPath, ensureGlobalDirs, TOPOLOGY_DB_PATH } from './global.js';
import { getProject, listProjects, registerProject } from './registry.js';
import { findProjectRoot } from './project-root.js';
import { TopologyStore } from './topology/topology-db.js';
import { FederationManager } from './federation/manager.js';
import type { TraceMcpConfig } from './config.js';

function registerDefaultPlugins(registry: PluginRegistry): void {
  for (const p of createAllLanguagePlugins()) registry.registerLanguagePlugin(p);
  for (const p of createAllIntegrationPlugins()) registry.registerFrameworkPlugin(p);
}

/**
 * Resolve DB path for a project:
 * 1. Check registry for the project root
 * 2. Fall back to global path computed from project root
 */
function resolveDbPath(projectRoot: string): string {
  const entry = getProject(projectRoot);
  if (entry) return entry.dbPath;
  return getDbPath(projectRoot);
}

/**
 * Auto-federation: after indexing, register the project in federation,
 * scan for contracts and client calls, and link to known endpoints.
 * Runs when topology is enabled (default: true) and auto_federation is true (default: true).
 */
function runFederationAutoSync(projectRoot: string, config: TraceMcpConfig): void {
  if (config.topology?.enabled === false) return;
  if (config.topology?.auto_federation === false) return;

  try {
    ensureGlobalDirs();
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    const manager = new FederationManager(topoStore);

    const result = manager.add(projectRoot, {
      contractPaths: config.topology?.contract_globs,
    });

    // Also sync any other previously federated repos to re-link
    const fedRepos = topoStore.getAllFederatedRepos();
    if (fedRepos.length > 1) {
      const linked = topoStore.linkClientCallsToEndpoints();
      if (linked > 0) {
        logger.info({ linked }, 'Federation: linked additional client calls');
      }
    }

    logger.info({
      repo: result.name,
      services: result.services,
      endpoints: result.endpoints,
      clientCalls: result.clientCalls,
      linkedCalls: result.linkedCalls,
    }, 'Federation auto-sync completed');

    topoStore.close();
  } catch (e) {
    logger.warn({ error: e }, 'Federation auto-sync failed (non-fatal)');
  }
}

const program = new Command();

program
  .name('trace-mcp')
  .description('Framework-Aware Code Intelligence for Laravel/Vue/Inertia/Nuxt')
  .version(PKG_VERSION);

program
  .command('serve')
  .description('Start MCP server (stdio transport)')
  .action(async () => {
    const projectRoot = process.cwd();

    // Auto-register project if not in registry
    const existing = getProject(projectRoot);
    if (!existing) {
      try {
        const root = findProjectRoot(projectRoot);
        ensureGlobalDirs();
        registerProject(root);
        logger.info({ root }, 'Auto-registered project');
      } catch {
        // Not a project dir — will still try to serve with defaults
      }
    }

    const configResult = await loadConfig(projectRoot);
    if (configResult.isErr()) {
      logger.error({ error: configResult.error }, 'Failed to load config');
      process.exit(1);
    }
    const config = configResult.value;

    // Attach file logging if configured
    if (config.logging) {
      attachFileLogging(config.logging);
    }

    const dbPath = resolveDbPath(projectRoot);
    ensureGlobalDirs();

    const db = initializeDatabase(dbPath);
    writeServerPid(db);
    const store = new Store(db);
    const registry = new PluginRegistry();
    registerDefaultPlugins(registry);

    const progress = new ProgressState(db);
    const pipeline = new IndexingPipeline(store, registry, config, projectRoot, progress);
    const watcher = new FileWatcher();

    const aiProvider = createAIProvider(config);
    const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
    const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
    const embeddingPipeline = vectorStore && embeddingService
      ? new EmbeddingPipeline(store, embeddingService, vectorStore, progress)
      : null;

    // Summarization pipeline (uses fast model + inference cache)
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
        logger.error({ error: err }, 'Embedding indexing failed');
      });
    };

    const runSummarization = () => {
      if (!summarizationPipeline) return;
      summarizationPipeline.summarizeUnsummarized().catch((err) => {
        logger.error({ error: err }, 'Summarization failed');
      });
    };

    // Initial index runs in background so the server starts immediately
    pipeline.indexAll().then(() => {
      runSummarization();
      runEmbeddings();
      runFederationAutoSync(projectRoot, config);
    }).catch((err) => {
      logger.error({ error: err }, 'Initial indexing failed');
    });

    await watcher.start(projectRoot, config, async (paths) => {
      await pipeline.indexFiles(paths);
      runSummarization();
      runEmbeddings();
    }, undefined, async (deleted) => {
      pipeline.deleteFiles(deleted);
    });

    const shutdown = async () => {
      clearServerPid(db);
      await watcher.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    const server = createServer(store, registry, config, projectRoot, progress);
    const transport = new StdioServerTransport();

    logger.info({ projectRoot, dbPath }, 'Starting trace-mcp MCP server...');
    await server.connect(transport);
  });

program
  .command('serve-http')
  .description('Start MCP server (HTTP/SSE transport)')
  .option('-p, --port <port>', 'Port to listen on', '3741')
  .option('--host <host>', 'Host to bind to', '127.0.0.1')
  .action(async (opts: { port: string; host: string }) => {
    const projectRoot = process.cwd();

    const configResult = await loadConfig(projectRoot);
    if (configResult.isErr()) {
      logger.error({ error: configResult.error }, 'Failed to load config');
      process.exit(1);
    }
    const config = configResult.value;

    // Attach file logging if configured
    if (config.logging) {
      attachFileLogging(config.logging);
    }

    const dbPath = resolveDbPath(projectRoot);
    ensureGlobalDirs();

    const db = initializeDatabase(dbPath);
    writeServerPid(db);
    const store = new Store(db);
    const registry = new PluginRegistry();
    registerDefaultPlugins(registry);

    const progress2 = new ProgressState(db);
    const pipeline = new IndexingPipeline(store, registry, config, projectRoot, progress2);
    const watcher = new FileWatcher();

    const aiProvider = createAIProvider(config);
    const vectorStore = config.ai?.enabled ? new BlobVectorStore(store.db) : null;
    const embeddingService = config.ai?.enabled ? aiProvider.embedding() : null;
    const embeddingPipeline = vectorStore && embeddingService
      ? new EmbeddingPipeline(store, embeddingService, vectorStore, progress2)
      : null;

    const inferenceCache2 = config.ai?.enabled ? new InferenceCache(store.db) : null;
    inferenceCache2?.evictExpired();
    const summarizationPipeline2 = config.ai?.enabled && config.ai.summarize_on_index !== false
      ? new SummarizationPipeline(
          store,
          new CachedInferenceService(aiProvider.fastInference(), inferenceCache2!, config.ai.fast_model ?? 'fast'),
          projectRoot,
          {
            batchSize: config.ai.summarize_batch_size ?? 20,
            kinds: config.ai.summarize_kinds ?? ['class', 'function', 'method', 'interface', 'trait', 'enum', 'type'],
            concurrency: config.ai.concurrency ?? 1,
          },
          progress2,
        )
      : null;

    const runEmbeddings = () => {
      if (!embeddingPipeline) return;
      embeddingPipeline.indexUnembedded().catch((err) => {
        logger.error({ error: err }, 'Embedding indexing failed');
      });
    };

    const runSummarization2 = () => {
      if (!summarizationPipeline2) return;
      summarizationPipeline2.summarizeUnsummarized().catch((err) => {
        logger.error({ error: err }, 'Summarization failed');
      });
    };

    pipeline.indexAll().then(() => {
      runSummarization2();
      runEmbeddings();
      runFederationAutoSync(projectRoot, config);
    }).catch((err) => {
      logger.error({ error: err }, 'Initial indexing failed');
    });

    await watcher.start(projectRoot, config, async (paths) => {
      await pipeline.indexFiles(paths);
      runSummarization2();
      runEmbeddings();
    }, undefined, async (deleted) => {
      pipeline.deleteFiles(deleted);
    });

    const port = parseInt(opts.port, 10);
    const host = opts.host;

    // Create a single MCP server + stateful transport (persists across requests)
    const server = createServer(store, registry, config, projectRoot, progress2);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    await server.connect(transport);

    // Simple per-IP rate limiter (token bucket: 60 requests/minute per IP)
    const RATE_WINDOW_MS = 60_000;
    const RATE_LIMIT = 60;
    const MAX_RATE_BUCKETS = 10_000;
    const rateBuckets = new Map<string, { count: number; resetAt: number }>();

    function isRateLimited(ip: string): boolean {
      const now = Date.now();
      const bucket = rateBuckets.get(ip);
      if (!bucket || now > bucket.resetAt) {
        // Evict expired entries if map is at capacity
        if (!bucket && rateBuckets.size >= MAX_RATE_BUCKETS) {
          for (const [key, b] of rateBuckets) {
            if (now > b.resetAt) rateBuckets.delete(key);
          }
          // Still full after eviction — reject to bound memory
          if (rateBuckets.size >= MAX_RATE_BUCKETS) return true;
        }
        rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return false;
      }
      bucket.count++;
      return bucket.count > RATE_LIMIT;
    }

    // Periodically evict expired rate-limit buckets to prevent memory leak
    const rateBucketCleanup = setInterval(() => {
      const now = Date.now();
      for (const [ip, bucket] of rateBuckets) {
        if (now > bucket.resetAt) rateBuckets.delete(ip);
      }
    }, RATE_WINDOW_MS);
    rateBucketCleanup.unref();

    const MAX_BODY_SIZE = 5 * 1024 * 1024;

    function collectBody(req: http.IncomingMessage): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_SIZE) {
            req.destroy();
            reject(new Error('BODY_TOO_LARGE'));
          } else {
            chunks.push(chunk);
          }
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
      });
    }

    const httpServer = http.createServer(async (req, res) => {
      const clientIp = req.socket.remoteAddress ?? 'unknown';

      if (isRateLimited(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }

      if (req.url === '/mcp') {
        try {
          let parsedBody: unknown;
          if (req.method === 'POST') {
            const body = await collectBody(req);
            parsedBody = JSON.parse(body.toString());
          }
          await transport.handleRequest(req, res, parsedBody);
        } catch (e: any) {
          if (e?.message === 'BODY_TOO_LARGE') {
            if (!res.headersSent) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Request body too large' }));
            }
            return;
          }
          logger.error({ error: e }, 'MCP request handling failed');
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        }
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'http' }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const shutdown = async () => {
      clearServerPid(db);
      await watcher.stop();
      await transport.close();
      await server.close();
      httpServer.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    httpServer.listen(port, host, () => {
      logger.info({ host, port, endpoint: `http://${host}:${port}/mcp` }, 'trace-mcp HTTP server started');
    });
  });

program
  .command('index')
  .description('Index a project directory')
  .argument('<dir>', 'Directory to index')
  .option('-f, --force', 'Force reindex all files')
  .action(async (dir: string, opts: { force?: boolean }) => {
    const resolvedDir = path.resolve(dir);
    if (!fs.existsSync(resolvedDir)) {
      logger.error({ dir: resolvedDir }, 'Directory does not exist');
      process.exit(1);
    }

    const configResult = await loadConfig(resolvedDir);
    if (configResult.isErr()) {
      logger.error({ error: configResult.error }, 'Failed to load config');
      process.exit(1);
    }
    const config = configResult.value;

    const dbPath = resolveDbPath(resolvedDir);
    ensureGlobalDirs();

    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const registry = new PluginRegistry();
    registerDefaultPlugins(registry);

    logger.info({ dir: resolvedDir, dbPath, force: opts.force ?? false }, 'Indexing started');

    const pipeline = new IndexingPipeline(store, registry, config, resolvedDir);
    const result = await pipeline.indexAll(opts.force ?? false);
    logger.info(result, 'Indexing completed');

    // Auto-federation: register this project, scan contracts & client calls
    runFederationAutoSync(resolvedDir, config);

    db.close();
  });

program
  .command('index-file')
  .description('Incrementally reindex a single file (called by the PostToolUse auto-reindex hook)')
  .argument('<file>', 'Absolute or relative path to the file to reindex')
  .action(async (file: string) => {
    const resolvedFile = path.resolve(file);
    if (!fs.existsSync(resolvedFile)) {
      process.exit(0); // file may have been deleted — exit silently
    }

    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(path.dirname(resolvedFile));
    } catch {
      process.exit(0); // not inside a known project — skip silently
    }

    const configResult = await loadConfig(projectRoot);
    if (configResult.isErr()) process.exit(0);
    const config = configResult.value;

    const dbPath = resolveDbPath(projectRoot);
    ensureGlobalDirs();

    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const registry = new PluginRegistry();
    registerDefaultPlugins(registry);

    const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
    await pipeline.indexFiles([resolvedFile]);
    db.close();
  });

program
  .command('setup-hooks')
  .description('Install Claude Code PreToolUse guard hook (alias: use `trace-mcp init` instead)')
  .option('--global', 'Install to ~/.claude/settings.json (default: project-level .claude/settings.local.json)')
  .option('--uninstall', 'Remove the hook')
  .action((opts: { global?: boolean; uninstall?: boolean }) => {
    if (opts.uninstall) {
      uninstallGuardHook({ global: opts.global });
      console.log('trace-mcp hook removed.');
      return;
    }
    const result = installGuardHook({ global: opts.global });
    console.log(`Hook ${result.action}: ${result.target}`);
    if (result.detail) console.log(`  ${result.detail}`);
  });

program
  .command('list')
  .description('List all registered projects')
  .option('--json', 'Output as JSON')
  .action((opts: { json?: boolean }) => {
    const projects = listProjects();
    if (opts.json) {
      console.log(JSON.stringify(projects, null, 2));
    } else if (projects.length === 0) {
      console.log('No projects registered. Run `trace-mcp add` in a project directory.');
    } else {
      console.log('Registered projects:\n');
      for (const p of projects) {
        const lastIdx = p.lastIndexed ? new Date(p.lastIndexed).toLocaleString() : 'never';
        const dbExists = fs.existsSync(p.dbPath) ? 'ok' : 'missing';
        console.log(`  ${p.name}`);
        console.log(`    Root: ${p.root}`);
        console.log(`    DB: ${dbExists}`);
        console.log(`    Last indexed: ${lastIdx}`);
        console.log();
      }
    }
  });

program.addCommand(initCommand);
program.addCommand(upgradeCommand);
program.addCommand(addCommand);
program.addCommand(removeCommand);
program.addCommand(doctorCommand);
program.addCommand(ciReportCommand);
program.addCommand(checkCommand);
program.addCommand(bundlesCommand);
program.addCommand(federationCommand);
program.addCommand(analyticsCommand);
program.addCommand(statusCommand);

program.parse();
