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
import { loadConfig, loadGlobalConfigRaw, validateConfigUpdate } from './config.js';
import { checkAndInstallUpdate, runPostUpdateMigrations } from './updater.js';
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
import { visualizeCommand } from './cli/visualize.js';
import { buildGraphData, generateHtml } from './tools/analysis/visualize.js';
import { daemonCommand } from './cli/daemon.js';
import { installGuardHook, uninstallGuardHook } from './init/hooks.js';
import { getDbPath, ensureGlobalDirs, TOPOLOGY_DB_PATH, GLOBAL_CONFIG_PATH, stripJsonComments, DAEMON_LOG_PATH } from './global.js';
import { getProject, listProjects, registerProject } from './registry.js';
import { findProjectRoot, detectGitWorktree } from './project-root.js';
import { TopologyStore } from './topology/topology-db.js';
import { FederationManager } from './federation/manager.js';
import { ProjectManager } from './daemon/project-manager.js';
import { isDaemonRunning } from './daemon/client.js';
import { DEFAULT_DAEMON_PORT } from './global.js';
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
  .version(PKG_VERSION, '-v, --version');

program
  .command('serve')
  .description('Start MCP server (stdio transport)')
  .action(async () => {
    const projectRoot = process.cwd();

    // Auto-update: check if a newer trace-mcp version is available and install it.
    // Controlled by ~/.trace-mcp/.config.json: { "auto_update": true, "auto_update_check_interval_hours": 24 }
    const globalRaw = loadGlobalConfigRaw();
    if (globalRaw.auto_update !== false) {
      const intervalHours =
        typeof globalRaw.auto_update_check_interval_hours === 'number'
          ? globalRaw.auto_update_check_interval_hours
          : 12;
      const updated = await checkAndInstallUpdate({ checkIntervalHours: intervalHours });
      if (updated) {
        // New version installed — exit cleanly. The MCP client will restart this
        // process, which will now run the updated binary.
        process.exit(0);
      }
    }

    // Post-update migrations: hooks, CLAUDE.md, reindex — runs once after version change
    await runPostUpdateMigrations();

    // Detect git linked worktrees so we share the main repo's index instead
    // of building a redundant copy.  projectRoot stays as the worktree path
    // (file watcher, path validation), but the DB comes from the main repo.
    const worktreeInfo = detectGitWorktree(projectRoot);
    const indexRoot = worktreeInfo?.mainRoot ?? projectRoot;

    if (worktreeInfo) {
      logger.info({ worktreeRoot: projectRoot, mainRoot: worktreeInfo.mainRoot }, 'Git worktree detected — sharing main repo index');
    }

    // Auto-register the index root (main repo if worktree, otherwise current project)
    const existing = getProject(indexRoot);
    if (!existing) {
      try {
        const root = findProjectRoot(indexRoot);
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

    const dbPath = resolveDbPath(indexRoot);
    ensureGlobalDirs();

    const db = initializeDatabase(dbPath);
    writeServerPid(db);
    const store = new Store(db);
    const registry = new PluginRegistry();
    registerDefaultPlugins(registry);

    const progress = new ProgressState(db);

    // Check if daemon is running — if so, skip indexer + watcher (daemon owns indexing)
    const daemonActive = await isDaemonRunning(DEFAULT_DAEMON_PORT);

    let watcher: FileWatcher | null = null;

    // Register this stdio client with the daemon so it appears in the menu bar app
    let daemonClientId: string | null = null;
    if (daemonActive) {
      logger.info({ port: DEFAULT_DAEMON_PORT }, 'Daemon detected — skipping indexer, serving MCP over existing DB');
      daemonClientId = randomUUID();
      fetch(`http://127.0.0.1:${DEFAULT_DAEMON_PORT}/api/clients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: daemonClientId, project: projectRoot, transport: 'stdio' }),
      }).catch(() => { /* best-effort */ });
    } else {
      const pipeline = new IndexingPipeline(store, registry, config, projectRoot, progress);
      watcher = new FileWatcher();

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
    }

    const shutdown = async () => {
      clearServerPid(db);
      if (watcher) await watcher.stop();
      if (daemonClientId) {
        await fetch(`http://127.0.0.1:${DEFAULT_DAEMON_PORT}/api/clients?id=${daemonClientId}`, { method: 'DELETE' }).catch(() => {});
      }
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    const server = createServer(store, registry, config, projectRoot, progress);
    const transport = new StdioServerTransport();

    logger.info({ projectRoot, indexRoot, dbPath, daemonActive }, 'Starting trace-mcp MCP server...');
    await server.connect(transport);
  });

program
  .command('serve-http')
  .description('Start MCP server (HTTP/SSE transport) — daemon mode, indexes all registered projects')
  .option('-p, --port <port>', 'Port to listen on', '3741')
  .option('--host <host>', 'Host to bind to', '127.0.0.1')
  .action(async (opts: { port: string; host: string }) => {
    // Auto-update (same logic as serve)
    const globalRaw = loadGlobalConfigRaw();
    if (globalRaw.auto_update !== false) {
      const intervalHours =
        typeof globalRaw.auto_update_check_interval_hours === 'number'
          ? globalRaw.auto_update_check_interval_hours
          : 12;
      const updated = await checkAndInstallUpdate({ checkIntervalHours: intervalHours });
      if (updated) process.exit(0);
    }

    // Post-update migrations: hooks, CLAUDE.md, reindex — runs once after version change
    await runPostUpdateMigrations();

    // Load and index ALL registered projects
    const projectManager = new ProjectManager();
    await projectManager.loadAllRegistered();

    // If cwd is a project not yet registered, add it too
    const cwd = process.cwd();
    if (!projectManager.getProject(cwd)) {
      try {
        const root = findProjectRoot(cwd);
        if (!projectManager.getProject(root)) {
          await projectManager.addProject(root);
        }
      } catch { /* cwd is not a project dir — fine */ }
    }

    // ── Client tracking ─────────────────────────────────────────
    interface TrackedClient {
      id: string;
      project: string;
      transport: string;
      connectedAt: string;
      lastSeen: string;
    }
    const clients = new Map<string, TrackedClient>();

    // ── SSE event bus ───────────────────────────────────────────
    type DaemonEvent =
      | { type: 'indexing_progress'; project: string; pipeline: string; phase: string; processed: number; total: number }
      | { type: 'project_status'; project: string; status: string; error?: string }
      | { type: 'client_connect'; clientId: string; project: string; transport?: string }
      | { type: 'client_disconnect'; clientId: string; project?: string };

    const sseConnections = new Set<http.ServerResponse>();

    function broadcastEvent(event: DaemonEvent): void {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of sseConnections) {
        try { res.write(data); } catch { sseConnections.delete(res); }
      }
    }

    // Subscribe to progress updates from all managed projects
    const progressUnsubscribers: (() => void)[] = [];
    function subscribeToProjectProgress(root: string): void {
      const managed = projectManager.getProject(root);
      if (!managed) return;
      const unsub = managed.progress.onUpdate((pipeline, progress) => {
        broadcastEvent({
          type: 'indexing_progress',
          project: root,
          pipeline,
          phase: progress.phase,
          processed: progress.processed,
          total: progress.total,
        });
      });
      progressUnsubscribers.push(unsub);
    }

    // Subscribe to all currently loaded projects
    for (const p of projectManager.listProjects()) {
      subscribeToProjectProgress(p.root);
    }

    // Per-project MCP transports (created on demand)
    const transports = new Map<string, StreamableHTTPServerTransport>();

    async function getOrCreateTransport(projectRoot: string): Promise<StreamableHTTPServerTransport | null> {
      const managed = projectManager.getProject(projectRoot);
      if (!managed) return null;

      let transport = transports.get(projectRoot);
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await managed.server.connect(transport);
        transports.set(projectRoot, transport);

        // Track client connection
        const clientId = randomUUID();
        clients.set(clientId, {
          id: clientId,
          project: projectRoot,
          transport: 'http',
          connectedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
        });
        broadcastEvent({ type: 'client_connect', clientId, project: projectRoot });
      }
      return transport;
    }

    const port = parseInt(opts.port, 10);
    const host = opts.host;

    // Simple per-IP rate limiter (token bucket: 60 requests/minute per IP)
    const RATE_WINDOW_MS = 60_000;
    const RATE_LIMIT = 60;
    const MAX_RATE_BUCKETS = 10_000;
    const rateBuckets = new Map<string, { count: number; resetAt: number }>();

    function isRateLimited(ip: string): boolean {
      const now = Date.now();
      const bucket = rateBuckets.get(ip);
      if (!bucket || now > bucket.resetAt) {
        if (!bucket && rateBuckets.size >= MAX_RATE_BUCKETS) {
          for (const [key, b] of rateBuckets) {
            if (now > b.resetAt) rateBuckets.delete(key);
          }
          if (rateBuckets.size >= MAX_RATE_BUCKETS) return true;
        }
        rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
        return false;
      }
      bucket.count++;
      return bucket.count > RATE_LIMIT;
    }

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

    const startedAt = Date.now();

    const httpServer = http.createServer(async (req, res) => {
      const clientIp = req.socket.remoteAddress ?? 'unknown';

      if (isRateLimited(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      // MCP endpoint — route to project via ?project= query param
      if (url.pathname === '/mcp') {
        const projectRoot = url.searchParams.get('project') ?? projectManager.listProjects()[0]?.root;
        if (!projectRoot) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No projects registered' }));
          return;
        }

        const transport = await getOrCreateTransport(projectRoot);
        if (!transport) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Project not found: ${projectRoot}` }));
          return;
        }

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

      // Health endpoint — includes project status
      if (req.method === 'GET' && url.pathname === '/health') {
        const projects = projectManager.listProjects().map((p) => ({
          root: p.root,
          status: p.status,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          transport: 'http',
          uptime: Math.floor((Date.now() - startedAt) / 1000),
          pid: process.pid,
          projects,
        }));
        return;
      }

      // REST API: search symbols in a project
      // Schema: symbols(id, file_id, symbol_id, name, kind, fqn, line_start, line_end, ...)
      //         nodes(id, node_type, ref_id) — ref_id points to symbols.id when node_type='symbol'
      //         edges(id, source_node_id, target_node_id, edge_type_id, metadata)
      //         edge_types(id, name), files(id, path)
      if (req.method === 'GET' && url.pathname === '/api/projects/symbols') {
        const projectRoot = url.searchParams.get('project');
        const query = url.searchParams.get('q') ?? '';
        const kind = url.searchParams.get('kind') ?? '';
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
        const isolated = url.searchParams.get('isolated') === 'true';
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?project= query param' }));
          return;
        }
        const managed = projectManager.getProject(projectRoot);
        if (!managed) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Project not found: ${projectRoot}` }));
          return;
        }
        try {
          const db = managed.store.db;
          let sql: string;
          let params: any[];

          if (isolated) {
            sql = `SELECT s.id, s.fqn, s.kind, f.path as file_path, s.line_start, s.line_end
                   FROM symbols s
                   JOIN files f ON f.id = s.file_id
                   LEFT JOIN nodes n ON n.ref_id = s.id AND n.node_type = 'symbol'
                   LEFT JOIN edges e_out ON e_out.source_node_id = n.id
                   LEFT JOIN edges e_in ON e_in.target_node_id = n.id
                   WHERE e_out.id IS NULL AND e_in.id IS NULL`;
            params = [];
            if (query) { sql += ` AND s.fqn LIKE ?`; params.push(`%${query}%`); }
            if (kind) { sql += ` AND s.kind = ?`; params.push(kind); }
            sql += ` LIMIT ?`;
            params.push(limit);
          } else {
            sql = `SELECT s.id, s.fqn, s.kind, f.path as file_path, s.line_start, s.line_end
                   FROM symbols s JOIN files f ON f.id = s.file_id WHERE 1=1`;
            params = [];
            if (query) { sql += ` AND s.fqn LIKE ?`; params.push(`%${query}%`); }
            if (kind) { sql += ` AND s.kind = ?`; params.push(kind); }
            sql += ` ORDER BY s.fqn LIMIT ?`;
            params.push(limit);
          }

          const symbols = db.prepare(sql).all(...params);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ symbols, count: symbols.length }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Query failed' }));
        }
        return;
      }

      // REST API: get edges for a specific symbol (debug view)
      if (req.method === 'GET' && url.pathname === '/api/projects/symbol/edges') {
        const projectRoot = url.searchParams.get('project');
        const symbolId = url.searchParams.get('id');
        if (!projectRoot || !symbolId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?project= or ?id= query param' }));
          return;
        }
        const managed = projectManager.getProject(projectRoot);
        if (!managed) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Project not found: ${projectRoot}` }));
          return;
        }
        try {
          const db = managed.store.db;
          const symbol = db.prepare(`
            SELECT s.id, s.fqn, s.kind, f.path as file_path, s.line_start, s.line_end
            FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?
          `).get(symbolId);
          // Find the node for this symbol
          const node = db.prepare(`SELECT id FROM nodes WHERE node_type = 'symbol' AND ref_id = ?`).get(symbolId) as any;
          let outgoing: any[] = [];
          let incoming: any[] = [];
          if (node) {
            outgoing = db.prepare(`
              SELECT et.name as type, e.metadata,
                     ts.id, ts.fqn, ts.kind, tf.path as file_path
              FROM edges e
              JOIN edge_types et ON et.id = e.edge_type_id
              JOIN nodes tn ON tn.id = e.target_node_id
              LEFT JOIN symbols ts ON tn.node_type = 'symbol' AND tn.ref_id = ts.id
              LEFT JOIN files tf ON tf.id = ts.file_id
              WHERE e.source_node_id = ?
            `).all(node.id);
            incoming = db.prepare(`
              SELECT et.name as type, e.metadata,
                     ss.id, ss.fqn, ss.kind, sf.path as file_path
              FROM edges e
              JOIN edge_types et ON et.id = e.edge_type_id
              JOIN nodes sn ON sn.id = e.source_node_id
              LEFT JOIN symbols ss ON sn.node_type = 'symbol' AND sn.ref_id = ss.id
              LEFT JOIN files sf ON sf.id = ss.file_id
              WHERE e.target_node_id = ?
            `).all(node.id);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ symbol, nodeId: node?.id ?? null, outgoing, incoming }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Query failed' }));
        }
        return;
      }

      // REST API: graph data (nodes + edges for D3 visualization)
      if (req.method === 'GET' && url.pathname === '/api/projects/graph') {
        const projectRoot = url.searchParams.get('project');
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?project= query param' }));
          return;
        }
        const managed = projectManager.getProject(projectRoot);
        if (!managed) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Project not found: ${projectRoot}` }));
          return;
        }
        try {
          const scope = url.searchParams.get('scope') ?? 'project';
          const depth = parseInt(url.searchParams.get('depth') ?? '2', 10);
          const granularity = (url.searchParams.get('granularity') ?? 'file') as 'file' | 'symbol';
          const layout = (url.searchParams.get('layout') ?? 'force') as 'force' | 'hierarchical' | 'radial';
          const hideIsolated = url.searchParams.get('hideIsolated') !== 'false';
          const symbolKinds = url.searchParams.get('symbolKinds')?.split(',').filter(Boolean);

          const { nodes, edges, communities } = buildGraphData(managed.store, {
            scope, depth, granularity, layout, hideIsolated, symbolKinds,
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ nodes, edges, communities }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Graph build failed' }));
        }
        return;
      }

      // REST API: graph as self-contained HTML (D3.js visualization)
      if (req.method === 'GET' && url.pathname === '/api/projects/graph/html') {
        const projectRoot = url.searchParams.get('project');
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing ?project= query param');
          return;
        }
        const managed = projectManager.getProject(projectRoot);
        if (!managed) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end(`Project not found: ${projectRoot}`);
          return;
        }
        try {
          const scope = url.searchParams.get('scope') ?? 'project';
          const depth = parseInt(url.searchParams.get('depth') ?? '2', 10);
          const granularity = (url.searchParams.get('granularity') ?? 'file') as 'file' | 'symbol';
          const layout = (url.searchParams.get('layout') ?? 'force') as 'force' | 'hierarchical' | 'radial';
          const hideIsolated = url.searchParams.get('hideIsolated') !== 'false';
          const symbolKinds = url.searchParams.get('symbolKinds')?.split(',').filter(Boolean);

          const { nodes, edges, communities } = buildGraphData(managed.store, {
            scope, depth, granularity, layout, hideIsolated, symbolKinds,
          });
          let html = generateHtml(nodes, edges, communities, layout);

          // Embedded mode: adapt styling for iframe in the menu bar app
          const embedded = url.searchParams.get('embedded') === 'true';
          const theme = url.searchParams.get('theme') ?? 'dark';
          if (embedded) {
            const bg = theme === 'light' ? '#f0f0f0' : '#1c1c1e';
            const textColor = theme === 'light' ? '#333' : '#ccc';
            const embeddedCSS = `<style>
              body { background: ${bg} !important; }
              #controls { display: none !important; }
              #stats { display: none !important; }
              .node text { fill: ${textColor} !important; }
            </style>`;
            html = html.replace('</head>', embeddedCSS + '</head>');
          }

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(e?.message ?? 'Graph build failed');
        }
        return;
      }

      // REST API: graph summary stats (for graph explorer)
      if (req.method === 'GET' && url.pathname === '/api/projects/graph-stats') {
        const projectRoot = url.searchParams.get('project');
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?project= query param' }));
          return;
        }
        const managed = projectManager.getProject(projectRoot);
        if (!managed) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Project not found: ${projectRoot}` }));
          return;
        }
        try {
          const db = managed.store.db;
          const totalSymbols = (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as any)?.c ?? 0;
          const totalEdges = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as any)?.c ?? 0;
          const isolatedCount = (db.prepare(`
            SELECT COUNT(*) as c FROM symbols s
            WHERE NOT EXISTS (
              SELECT 1 FROM nodes n
              JOIN edges e ON e.source_node_id = n.id OR e.target_node_id = n.id
              WHERE n.node_type = 'symbol' AND n.ref_id = s.id
            )
          `).get() as any)?.c ?? 0;

          const kindBreakdown = db.prepare('SELECT kind, COUNT(*) as count FROM symbols GROUP BY kind ORDER BY count DESC').all();
          const edgeBreakdown = db.prepare(`
            SELECT et.name as type, COUNT(*) as count
            FROM edges e JOIN edge_types et ON et.id = e.edge_type_id
            GROUP BY et.name ORDER BY count DESC
          `).all();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            totalSymbols, totalEdges, isolatedCount,
            kindBreakdown, edgeBreakdown,
          }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Query failed' }));
        }
        return;
      }

      // REST API: project stats (files, symbols, edges)
      if (req.method === 'GET' && url.pathname === '/api/projects/stats') {
        const projectRoot = url.searchParams.get('project');
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?project= query param' }));
          return;
        }
        const managed = projectManager.getProject(projectRoot);
        if (!managed) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Project not found: ${projectRoot}` }));
          return;
        }
        try {
          const db = managed.store.db;
          const files = (db.prepare('SELECT COUNT(*) as c FROM files').get() as any)?.c ?? 0;
          const symbols = (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as any)?.c ?? 0;
          const edges = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as any)?.c ?? 0;
          const lastRow = db.prepare('SELECT MAX(indexed_at) as t FROM files').get() as any;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ files, symbols, edges, lastIndexed: lastRow?.t ?? null }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Failed to get stats' }));
        }
        return;
      }

      // REST API: list projects
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        const projects = projectManager.listProjects().map((p) => ({
          root: p.root,
          status: p.status,
          error: p.error,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects }));
        return;
      }

      // REST API: trigger reindex for a project
      if (req.method === 'POST' && url.pathname === '/api/projects/reindex') {
        const projectRoot = url.searchParams.get('project');
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?project= query param' }));
          return;
        }
        const managed = projectManager.getProject(projectRoot);
        if (!managed) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Project not found: ${projectRoot}` }));
          return;
        }
        managed.pipeline.indexAll(true).catch((err) => {
          logger.error({ error: err, projectRoot }, 'Reindex failed');
        });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'reindex_started', project: projectRoot }));
        return;
      }

      // REST API: add a project
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        try {
          const body = await collectBody(req);
          const { root } = JSON.parse(body.toString()) as { root: string };
          if (!root || !fs.existsSync(root)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid or missing root path' }));
            return;
          }
          await projectManager.addProject(root);
          subscribeToProjectProgress(root);
          broadcastEvent({ type: 'project_status', project: root, status: 'indexing' });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'added', project: root }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Failed to add project' }));
        }
        return;
      }

      // REST API: remove a project
      if (req.method === 'DELETE' && url.pathname === '/api/projects') {
        const projectRoot = url.searchParams.get('project');
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?project= query param' }));
          return;
        }
        await projectManager.removeProject(projectRoot);
        broadcastEvent({ type: 'project_status', project: projectRoot, status: 'removed' });
        // Clean up client entries for this project
        for (const [id, client] of clients) {
          if (client.project === projectRoot) {
            clients.delete(id);
            broadcastEvent({ type: 'client_disconnect', clientId: id, project: projectRoot });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'removed', project: projectRoot }));
        return;
      }

      // REST API: connected MCP clients
      if (req.method === 'GET' && url.pathname === '/api/clients') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ clients: Array.from(clients.values()) }));
        return;
      }

      // REST API: register a client (used by stdio serve processes to announce themselves)
      if (req.method === 'POST' && url.pathname === '/api/clients') {
        try {
          const body = await collectBody(req);
          const { id, project, transport: t } = JSON.parse(body.toString()) as { id: string; project: string; transport: string };
          const now = new Date().toISOString();
          clients.set(id, { id, project, transport: t || 'stdio', connectedAt: now, lastSeen: now });
          broadcastEvent({ type: 'client_connect', clientId: id, transport: t || 'stdio', project });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'registered' }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Bad request' }));
        }
        return;
      }

      // REST API: unregister a client
      if (req.method === 'DELETE' && url.pathname === '/api/clients') {
        const clientId = url.searchParams.get('id');
        if (clientId) {
          const existing = clients.get(clientId);
          clients.delete(clientId);
          broadcastEvent({ type: 'client_disconnect', clientId, project: existing?.project });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'removed' }));
        return;
      }

      // REST API: read global settings
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        const raw = loadGlobalConfigRaw();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          settings: raw,
          path: GLOBAL_CONFIG_PATH,
          daemon: {
            port,
            host,
            log_path: DAEMON_LOG_PATH,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            pid: process.pid,
          },
        }));
        return;
      }

      // REST API: update global settings
      if (req.method === 'PUT' && url.pathname === '/api/settings') {
        try {
          const body = await collectBody(req);
          const incoming = JSON.parse(body.toString()) as Record<string, unknown>;

          // Validate known section types
          const errors = validateConfigUpdate(incoming);
          if (errors.length > 0) {
            res.writeHead(422, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Validation failed', details: errors }));
            return;
          }

          // Merge with existing config (shallow per top-level key)
          const existing = loadGlobalConfigRaw();
          const merged = { ...existing };
          for (const [key, value] of Object.entries(incoming)) {
            if (value !== undefined) merged[key] = value;
          }
          ensureGlobalDirs();
          fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(merged, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'updated', settings: merged }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Invalid JSON body' }));
        }
        return;
      }

      // REST API: SSE event stream
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        // Send initial snapshot of all project statuses
        for (const p of projectManager.listProjects()) {
          const snap = p.progress.snapshot();
          res.write(`data: ${JSON.stringify({
            type: 'project_status',
            project: p.root,
            status: p.status,
            error: p.error,
            progress: snap,
          })}\n\n`);
        }
        sseConnections.add(res);
        req.on('close', () => { sseConnections.delete(res); });
        // Keep-alive ping every 30s
        const keepAlive = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); sseConnections.delete(res); }
        }, 30_000);
        req.on('close', () => clearInterval(keepAlive));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const shutdown = async () => {
      // Close SSE connections
      for (const res of sseConnections) {
        try { res.end(); } catch { /* ignore */ }
      }
      sseConnections.clear();
      // Unsubscribe progress listeners
      for (const unsub of progressUnsubscribers) unsub();
      // Close all transports
      for (const transport of transports.values()) {
        await transport.close().catch(() => {});
      }
      await projectManager.shutdown();
      httpServer.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    httpServer.listen(port, host, () => {
      const projectCount = projectManager.listProjects().length;
      logger.info({ host, port, projectCount, endpoint: `http://${host}:${port}/mcp` }, 'trace-mcp daemon started');
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
program.addCommand(visualizeCommand);
program.addCommand(daemonCommand);

program.parse();
