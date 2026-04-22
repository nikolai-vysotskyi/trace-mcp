#!/usr/bin/env node

import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
declare const PKG_VERSION_INJECTED: string;
const PKG_VERSION = typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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
import { createAIProvider, BlobVectorStore, EmbeddingPipeline, InferenceCache, CachedInferenceService, aiTracker } from './ai/index.js';
import { SummarizationPipeline } from './ai/summarization-pipeline.js';
import { ProgressState, writeServerPid, clearServerPid } from './progress.js';
import { detectCoverageRecursive } from './analytics/tech-detector.js';
import http from 'node:http';
import { initCommand } from './cli/init.js';
import { upgradeCommand } from './cli/upgrade.js';
import { addCommand } from './cli/add.js';
import { doctorCommand } from './cli/doctor.js';
import { ciReportCommand } from './cli/ci.js';
import { checkCommand } from './cli/check.js';
import { bundlesCommand } from './cli/bundles.js';
import { subprojectCommand } from './cli/subproject.js';
import { memoryCommand } from './cli/memory.js';
import { analyticsCommand } from './cli/analytics.js';
import { removeCommand } from './cli/remove.js';
import { statusCommand } from './cli/status.js';
import { visualizeCommand } from './cli/visualize.js';
import { buildGraphData, generateHtml } from './tools/analysis/visualize.js';
import { scanCodeSmells } from './tools/quality/code-smells.js';
import { daemonCommand } from './cli/daemon.js';
import { installAppCommand } from './cli/install-app.js';
import { askCommand } from './cli/ask.js';
import { exportSecurityContextCommand } from './cli/export-security-context.js';
import { installGuardHook, uninstallGuardHook } from './init/hooks.js';
import { getDbPath, ensureGlobalDirs, TOPOLOGY_DB_PATH, GLOBAL_CONFIG_PATH, stripJsonComments, DAEMON_LOG_PATH } from './global.js';
import { getProject, listProjects, resolveRegisteredAncestor } from './registry.js';
import { setupProject, isDangerousProjectRoot } from './project-setup.js';
import { findProjectRoot, detectGitWorktree } from './project-root.js';
import { TopologyStore } from './topology/topology-db.js';
import { SubprojectManager } from './subproject/manager.js';
import { ProjectManager } from './daemon/project-manager.js';
import { isDaemonRunning } from './daemon/client.js';
import { StdioSession } from './daemon/router/session.js';
import { DaemonIdleMonitor } from './daemon/idle-monitor.js';
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
 * Auto-discover subprojects: after indexing, detect services within the project
 * and register each as a subproject bound to this project.
 * A subproject is any working repository in the project ecosystem (microservices,
 * frontends, backends, shared libraries, CLI tools, etc.).
 * Runs when topology is enabled (default: true) and auto_discover is true (default: true).
 */
function runSubprojectAutoSync(projectRoot: string, config: TraceMcpConfig): void {
  if (config.topology?.enabled === false) return;
  if (config.topology?.auto_discover === false) return;

  try {
    ensureGlobalDirs();
    const topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
    const manager = new SubprojectManager(topoStore);

    const { services } = manager.autoDiscoverSubprojects(projectRoot, {
      contractPaths: config.topology?.contract_globs,
    });

    // Also re-link any other previously registered subprojects
    const subprojects = topoStore.getAllSubprojects();
    if (subprojects.length > 1) {
      const linked = topoStore.linkClientCallsToEndpoints();
      if (linked > 0) {
        logger.info({ linked }, 'Subproject: linked additional client calls');
      }
    }

    const totalEndpoints = services.reduce((sum, s) => sum + s.endpoints, 0);
    const totalClientCalls = services.reduce((sum, s) => sum + s.clientCalls, 0);
    logger.info({
      project: projectRoot,
      subprojects: services.length,
      serviceNames: services.map((s) => s.name),
      endpoints: totalEndpoints,
      clientCalls: totalClientCalls,
    }, 'Subproject auto-sync completed');

    topoStore.close();
  } catch (e) {
    logger.warn({ error: e }, 'Subproject auto-sync failed (non-fatal)');
  }
}

const program = new Command();

program
  .name('trace-mcp')
  .description('Framework-Aware Code Intelligence for Laravel/Vue/Inertia/Nuxt')
  .version(PKG_VERSION, '-v, --version');

program
  .command('serve', { isDefault: true })
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

    // Auto-register the index root (main repo if worktree, otherwise current project).
    // Only register if findProjectRoot resolves to indexRoot itself — never climb
    // above CWD, which would accidentally register a parent directory
    // (e.g. ~/PhpstormProjects when CWD is ~/PhpstormProjects/some-project).
    const existing = getProject(indexRoot);
    if (!existing) {
      try {
        const root = findProjectRoot(indexRoot);
        if (root === path.resolve(indexRoot)) {
          setupProject(root);
          logger.info({ root }, 'Auto-registered project');
        } else {
          logger.debug({ cwd: indexRoot, resolvedRoot: root }, 'Skipped auto-register: project root is above CWD');
        }
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

    // ── Stdio session: unified proxy ⇄ full mode with zero-downtime swap ──
    // One long-lived stdio process that hot-swaps between forwarding to the
    // daemon (when alive) and running a local McpServer (when daemon is dead).
    // See src/daemon/router/session.ts for the full state machine.
    const sharedDbPath = resolveDbPath(indexRoot);
    const idleTimeoutMs = (config.idle_timeout_minutes ?? 30) * 60_000;
    const daemonStabilityMs = (config.daemon_stability_seconds ?? 30) * 1_000;
    const drainTimeoutMs = config.backend_swap_drain_ms ?? 5_000;
    const autoSpawnDaemon = process.env.TRACE_MCP_NO_DAEMON === '1'
      ? false
      : (config.auto_spawn_daemon ?? true);
    const autoSpawnTimeoutMs = (config.daemon_spawn_timeout_seconds ?? 5) * 1_000;

    const session = new StdioSession({
      projectRoot,
      indexRoot,
      config,
      sharedDbPath,
      daemonPort: DEFAULT_DAEMON_PORT,
      idleTimeoutMs,
      daemonStabilityMs,
      drainTimeoutMs,
      autoSpawnDaemon,
      autoSpawnTimeoutMs,
    });

    let shuttingDown = false;
    const shutdown = async (reason: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ reason }, 'Shutting down trace-mcp server');
      try { await session.shutdown(reason); } catch (err) {
        logger.warn({ err: String(err) }, 'Session shutdown errored');
      }
      process.exit(0);
    };

    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
    // Orphan prevention: when the MCP client exits, stdin closes.
    process.stdin.on('end', () => { void shutdown('stdin-end'); });
    process.stdin.on('close', () => { void shutdown('stdin-close'); });

    logger.info({ projectRoot, indexRoot, idleTimeoutMs, daemonStabilityMs }, 'Starting trace-mcp stdio session...');
    await session.bootstrap();
    // session.bootstrap() called stdio.start() which resolves when stdin closes.
    // The process stays alive on the stdin event loop; shutdown handlers above
    // take care of exit.
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
      name?: string;
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
      | { type: 'client_connect'; clientId: string; project: string; transport?: string; name?: string }
      | { type: 'client_update'; clientId: string; project?: string; name?: string }
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

    // Shared project-level resources (TopologyStore, DecisionStore) — avoids per-session SQLite overhead
    const { ProjectResourcePool } = await import('./daemon/resource-pool.js');
    const resourcePool = new ProjectResourcePool();

    // Per-session MCP transports: sessionId → transport
    // Multiple clients can connect to the same project simultaneously.
    const sessionTransports = new Map<string, StreamableHTTPServerTransport>();
    // Session handles for cleanup: sessionId → ServerHandle
    const sessionHandles = new Map<string, import('./server/server.js').ServerHandle>();
    // Session → client tracking: sessionId → clientId
    const sessionClients = new Map<string, string>();
    // Reverse lookup: projectRoot → Set<sessionId> (for cleanup)
    const projectSessions = new Map<string, Set<string>>();

    async function createSessionTransport(projectRoot: string): Promise<StreamableHTTPServerTransport | null> {
      const managed = projectManager.getProject(projectRoot);
      if (!managed) return null;

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // Each session needs its own Server instance since the MCP SDK's Server
      // only supports one transport at a time. All sessions share the same
      // underlying Store/Pipeline/Registry via the managed project.
      // TopologyStore and DecisionStore are shared via resource pool.
      const deps = resourcePool.acquire(projectRoot, managed.config);
      const handle = createServer(
        managed.store, managed.registry, managed.config,
        managed.root, managed.progress,
        deps,
      );
      await handle.server.connect(transport);

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

      // Preserve the onclose handler wired by Protocol.connect() above — overwriting
      // it would skip Protocol's own state cleanup. Chain ours after it.
      const protocolOnClose = transport.onclose;
      transport.onclose = () => {
        protocolOnClose?.();
        const sid = transport.sessionId;
        if (sid) {
          // Clean up session resources. Do NOT call h.server.close() here: the
          // transport is already closing (that's why onclose fires), and
          // server.close() → transport.close() → fires onclose synchronously
          // again → infinite recursion → stack overflow.
          sessionTransports.delete(sid);
          projectSessions.get(projectRoot)?.delete(sid);

          const h = sessionHandles.get(sid);
          if (h) {
            h.dispose();
            sessionHandles.delete(sid);
          }

          const cid = sessionClients.get(sid);
          if (cid) {
            clients.delete(cid);
            broadcastEvent({ type: 'client_disconnect', clientId: cid, project: projectRoot });
            sessionClients.delete(sid);
          }

          // Release shared resources ref
          resourcePool.release(projectRoot);
          idleMonitor.onActivity();
        }
      };

      // Store handle and client mapping (will be registered after session ID is assigned)
      // The session ID is set by handleRequest during initialize, so we store by transport ref
      // and move to sessionHandles map after the initialize response.
      (transport as any).__pendingHandle = handle;
      (transport as any).__pendingClientId = clientId;

      return transport;
    }

    function getTransportBySessionId(sessionId: string): StreamableHTTPServerTransport | undefined {
      return sessionTransports.get(sessionId);
    }

    const port = parseInt(opts.port, 10);
    const host = opts.host;

    // Simple per-IP rate limiter (token bucket). Localhost is exempt because
    // the Electron app and local tooling legitimately make bursts of requests
    // (graph refetch, theme switching, etc.) that would otherwise trip the limit.
    const RATE_WINDOW_MS = 60_000;
    const RATE_LIMIT = 2000;
    const MAX_RATE_BUCKETS = 10_000;
    const rateBuckets = new Map<string, { count: number; resetAt: number }>();

    const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', 'unknown']);
    function isLocalhost(ip: string): boolean {
      return LOCALHOST_IPS.has(ip);
    }

    function isRateLimited(ip: string): boolean {
      if (isLocalhost(ip)) return false;
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

      // CORS: allow Electron renderer (and local dev) to read custom headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'X-Graph-Nodes, X-Graph-Edges, X-Graph-Communities');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.writeHead(204);
        res.end();
        return;
      }

      if (isRateLimited(clientIp)) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      // MCP endpoint — route by session ID, create new session on initialize
      if (url.pathname === '/mcp') {
        const requestedRoot = url.searchParams.get('project') ?? projectManager.listProjects()[0]?.root;
        if (!requestedRoot) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No projects registered' }));
          return;
        }
        // Resolve subdirectory requests to the registered parent project so we
        // don't spin up a duplicate index per nested package.
        const ancestor = resolveRegisteredAncestor(requestedRoot);
        const projectRoot = ancestor?.root ?? requestedRoot;

        try {
          let parsedBody: unknown;
          if (req.method === 'POST') {
            const body = await collectBody(req);
            parsedBody = JSON.parse(body.toString());
          }

          // Route by session ID for existing sessions
          const sessionId = req.headers['mcp-session-id'] as string | undefined;
          let transport: StreamableHTTPServerTransport | undefined;

          if (sessionId) {
            transport = getTransportBySessionId(sessionId);
            if (!transport) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Session not found' }, id: null }));
              return;
            }
          } else if (req.method === 'POST' && isInitializeRequest(parsedBody)) {
            // New session: create transport + server
            transport = await createSessionTransport(projectRoot) ?? undefined;
            if (!transport) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Project not found: ${projectRoot}` }));
              return;
            }
          } else {
            // No session ID and not an initialize. This most commonly happens
            // when the daemon restarted and a client is still trying to reuse
            // its in-memory state. Return 404 with a clear "reinitialize"
            // message so MCP clients that follow the spec's recovery path
            // (re-run `initialize`) can do so automatically. Previously we
            // returned 400 "Missing session ID" which some clients treat as
            // a hard protocol error rather than recoverable session loss.
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Session expired, reinitialize required' },
              id: null,
            }));
            return;
          }

          await transport.handleRequest(req, res, parsedBody);

          // After handling initialize, store the transport by its new session ID
          if (isInitializeRequest(parsedBody) && transport.sessionId) {
            const sid = transport.sessionId;
            sessionTransports.set(sid, transport);
            if (!projectSessions.has(projectRoot)) {
              projectSessions.set(projectRoot, new Set());
            }
            projectSessions.get(projectRoot)!.add(sid);
            idleMonitor.onActivity();

            // Move pending handle/clientId to session-keyed maps
            const pendingHandle = (transport as any).__pendingHandle;
            const pendingClientId = (transport as any).__pendingClientId;
            if (pendingHandle) {
              sessionHandles.set(sid, pendingHandle);
              delete (transport as any).__pendingHandle;
            }
            if (pendingClientId) {
              sessionClients.set(sid, pendingClientId);
              delete (transport as any).__pendingClientId;
            }
          }
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
          version: PKG_VERSION,
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
          const maxFiles = url.searchParams.has('maxFiles') ? parseInt(url.searchParams.get('maxFiles')!, 10) : undefined;
          const maxNodes = url.searchParams.has('maxNodes') ? parseInt(url.searchParams.get('maxNodes')!, 10) : undefined;
          const includeBottlenecks = url.searchParams.get('includeBottlenecks') === 'true';

          // Open topoStore for subproject support (best-effort)
          let topoStore: InstanceType<typeof TopologyStore> | undefined;
          try {
            if (fs.existsSync(TOPOLOGY_DB_PATH)) topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
          } catch { /* subproject support is optional */ }

          try {
            const { nodes, edges, communities } = buildGraphData(managed.store, {
              scope, depth, granularity, layout, hideIsolated, symbolKinds, maxFiles, maxNodes, topoStore, projectRoot, includeBottlenecks,
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ nodes, edges, communities }));
          } finally {
            topoStore?.close();
          }
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
          const maxFiles = url.searchParams.has('maxFiles') ? parseInt(url.searchParams.get('maxFiles')!, 10) : undefined;
          const maxNodes = url.searchParams.has('maxNodes') ? parseInt(url.searchParams.get('maxNodes')!, 10) : undefined;
          const highlightDepth = url.searchParams.has('highlightDepth') ? parseInt(url.searchParams.get('highlightDepth')!, 10) : undefined;

          // Open topoStore for subproject support (best-effort)
          let topoStore: InstanceType<typeof TopologyStore> | undefined;
          try {
            if (fs.existsSync(TOPOLOGY_DB_PATH)) topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
          } catch { /* subproject support is optional */ }

          try {
            const { nodes, edges, communities } = buildGraphData(managed.store, {
              scope, depth, granularity, layout, hideIsolated, symbolKinds, maxFiles, maxNodes, topoStore, projectRoot, highlightDepth,
            });
            let html = generateHtml(nodes, edges, communities, layout, { highlightDepth });

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

            // Send stats via headers so the client can skip the separate JSON fetch
            res.writeHead(200, {
              'Content-Type': 'text/html',
              'X-Graph-Nodes': String(nodes.length),
              'X-Graph-Edges': String(edges.length),
              'X-Graph-Communities': String(communities.length),
            });
            res.end(html);
          } finally {
            topoStore?.close();
          }
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

      // REST API: quality findings (code smells incl. debug artifacts)
      if (req.method === 'GET' && url.pathname === '/api/projects/smells') {
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
        const categoryParam = url.searchParams.get('category');
        const categories = categoryParam
          ? categoryParam.split(',').map((c) => c.trim()).filter(Boolean)
          : undefined;
        const priorityThreshold = url.searchParams.get('priority_threshold') ?? undefined;
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '500', 10), 2000);
        try {
          const result = scanCodeSmells(managed.store, projectRoot, {
            category: categories as any,
            priority_threshold: priorityThreshold as any,
            limit,
          });
          if (result.isErr()) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(result.error) }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.value));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Failed to scan code smells' }));
        }
        return;
      }

      // REST API: technology coverage analysis for a project
      // Recursively walks sub-projects so monorepo / multi-service containers
      // (whose root has no manifest) aggregate coverage from all children.
      if (req.method === 'GET' && url.pathname === '/api/projects/coverage') {
        const projectRoot = url.searchParams.get('project');
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?project= query param' }));
          return;
        }
        try {
          const multi = detectCoverageRecursive(projectRoot);

          // Deduplicate gaps across sub-projects by package name, keeping highest priority.
          const gapPrio = { high: 0, medium: 1, low: 2 } as const;
          const gapMap = new Map<string, (typeof multi.projects)[number]['gaps'][number]>();
          for (const p of multi.projects) {
            for (const g of p.gaps) {
              const existing = gapMap.get(g.name);
              if (!existing || (gapPrio[g.priority] ?? 3) < (gapPrio[existing.priority] ?? 3)) {
                gapMap.set(g.name, g);
              }
            }
          }
          const gaps = [...gapMap.values()].sort(
            (a, b) => (gapPrio[a.priority] ?? 3) - (gapPrio[b.priority] ?? 3),
          );

          // Deduplicate unknown packages by name, keeping strongest signal (likely > maybe > no).
          const needPrio = { likely: 0, maybe: 1, no: 2 } as const;
          const unknownMap = new Map<string, (typeof multi.projects)[number]['unknown'][number]>();
          for (const p of multi.projects) {
            for (const u of p.unknown) {
              const existing = unknownMap.get(u.name);
              if (!existing || (needPrio[u.needs_plugin] ?? 3) < (needPrio[existing.needs_plugin] ?? 3)) {
                unknownMap.set(u.name, u);
              }
            }
          }
          const unknown = [...unknownMap.values()].sort(
            (a, b) => (needPrio[a.needs_plugin] ?? 3) - (needPrio[b.needs_plugin] ?? 3),
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            coverage: {
              total_significant: multi.aggregate.total_significant,
              covered: multi.aggregate.covered,
              coverage_pct: multi.aggregate.coverage_pct,
            },
            gaps,
            unknown,
          }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Failed to detect coverage' }));
        }
        return;
      }

      // REST API: list files with sort options (for app sidebar)
      if (req.method === 'GET' && url.pathname === '/api/projects/files') {
        const projectRoot = url.searchParams.get('project');
        const sortBy = url.searchParams.get('sort') ?? 'symbols';
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '30', 10), 100);
        const scope = url.searchParams.get('scope')?.trim() || '';
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

          // Scope filter: match files by path prefix or glob-like pattern
          let SCOPE_FILTER = '';
          const scopeParams: string[] = [];
          if (scope) {
            if (scope.includes('*')) {
              // Convert glob to LIKE: src/*.ts → src/%.ts
              SCOPE_FILTER = `AND f.path LIKE ?`;
              scopeParams.push(scope.replace(/\*/g, '%'));
            } else if (scope.endsWith('/')) {
              SCOPE_FILTER = `AND f.path LIKE ?`;
              scopeParams.push(`%${scope}%`);
            } else {
              // Could be a directory prefix or exact file
              SCOPE_FILTER = `AND (f.path LIKE ? OR f.path LIKE ?)`;
              scopeParams.push(`%/${scope}%`, `%${scope}/%`);
            }
          }

          // Exclude non-code files from all queries
          const CODE_FILTER = `
              AND f.path NOT LIKE '%.md'
              AND f.path NOT LIKE '%.json'
              AND f.path NOT LIKE '%.yaml'
              AND f.path NOT LIKE '%.yml'
              AND f.path NOT LIKE '%.toml'
              AND f.path NOT LIKE '%.txt'
              AND f.path NOT LIKE '%.css'
              AND f.path NOT LIKE '%.html'
              AND f.path NOT LIKE '%.svg'
              AND f.path NOT LIKE '%.lock'
              AND f.path NOT LIKE '%.env%'
              AND f.path NOT LIKE '%package.json'
              AND f.path NOT LIKE '%tsconfig%'
          `;

          if (sortBy === 'isolated') {
            sql = `
              SELECT f.path,
                     COUNT(DISTINCT s.id) as symbols,
                     0 as edges
              FROM files f
              JOIN symbols s ON s.file_id = f.id
              LEFT JOIN nodes n ON n.ref_id = s.id AND n.node_type = 'symbol'
              LEFT JOIN edges e_out ON e_out.source_node_id = n.id
              LEFT JOIN edges e_in ON e_in.target_node_id = n.id
              WHERE e_out.id IS NULL AND e_in.id IS NULL
              ${CODE_FILTER} ${SCOPE_FILTER}
              GROUP BY f.id
              HAVING symbols > 0
              ORDER BY symbols DESC
              LIMIT ?
            `;
          } else if (sortBy === 'edges') {
            sql = `
              SELECT f.path,
                     COUNT(DISTINCT s.id) as symbols,
                     COUNT(DISTINCT e.id) as edges
              FROM files f
              JOIN symbols s ON s.file_id = f.id
              LEFT JOIN nodes n ON n.ref_id = s.id AND n.node_type = 'symbol'
              LEFT JOIN edges e ON e.source_node_id = n.id OR e.target_node_id = n.id
              WHERE 1=1 ${CODE_FILTER} ${SCOPE_FILTER}
              GROUP BY f.id
              ORDER BY edges DESC
              LIMIT ?
            `;
          } else if (sortBy === 'recent') {
            sql = `
              SELECT f.path,
                     COUNT(DISTINCT s.id) as symbols,
                     0 as edges
              FROM files f
              LEFT JOIN symbols s ON s.file_id = f.id
              WHERE 1=1 ${CODE_FILTER} ${SCOPE_FILTER}
              GROUP BY f.id
              ORDER BY f.indexed_at DESC
              LIMIT ?
            `;
          } else {
            sql = `
              SELECT f.path,
                     COUNT(DISTINCT s.id) as symbols,
                     0 as edges
              FROM files f
              LEFT JOIN symbols s ON s.file_id = f.id
              WHERE 1=1 ${CODE_FILTER} ${SCOPE_FILTER}
              GROUP BY f.id
              ORDER BY symbols DESC
              LIMIT ?
            `;
          }

          const files = db.prepare(sql).all(...scopeParams, limit) as { path: string; symbols: number; edges: number }[];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ files, sort: sortBy }));
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Query failed' }));
        }
        return;
      }

      // REST API: list subprojects for a project
      if (req.method === 'GET' && url.pathname === '/api/projects/subprojects') {
        try {
          let topoStore: InstanceType<typeof TopologyStore> | undefined;
          try {
            if (fs.existsSync(TOPOLOGY_DB_PATH)) topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
          } catch { /* subproject support is optional */ }

          if (!topoStore) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ repos: [], services: [] }));
            return;
          }

          try {
            const manager = new SubprojectManager(topoStore);
            const projectRoot = url.searchParams.get('project') ?? undefined;
            const result = manager.list(projectRoot);

            // Also return services with project_group for UI grouping
            const servicesWithCounts = topoStore.getServicesWithEndpointCounts(projectRoot);
            const services = servicesWithCounts.map((s) => ({
              id: s.id,
              name: s.name,
              repoRoot: s.repo_root,
              serviceType: s.service_type,
              projectGroup: s.project_group,
              endpointCount: s.endpoint_count,
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ repos: result.repos, services }));
          } finally {
            topoStore.close();
          }
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Subproject query failed' }));
        }
        return;
      }

      // REST API: update service project_group
      if (req.method === 'PATCH' && url.pathname === '/api/projects/services') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { serviceId, projectGroup } = JSON.parse(body) as { serviceId: number; projectGroup: string | null };
            if (serviceId == null) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'serviceId is required' }));
              return;
            }

            let topoStore: InstanceType<typeof TopologyStore> | undefined;
            try {
              ensureGlobalDirs();
              topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
            } catch (e: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e?.message ?? 'Failed to open topology DB' }));
              return;
            }

            try {
              topoStore.updateServiceGroup(serviceId, projectGroup ?? null);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } finally {
              topoStore.close();
            }
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          }
        });
        return;
      }

      // REST API: add a subproject to a project
      if (req.method === 'POST' && url.pathname === '/api/projects/subprojects') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { repoPath, project } = JSON.parse(body) as { repoPath: string; project: string };
            if (!repoPath || !project) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'repoPath and project are required' }));
              return;
            }

            let topoStore: InstanceType<typeof TopologyStore> | undefined;
            try {
              ensureGlobalDirs();
              topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
            } catch (e: any) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e?.message ?? 'Failed to open topology DB' }));
              return;
            }

            try {
              const manager = new SubprojectManager(topoStore);
              const result = manager.add(repoPath, project);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (e: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: e?.message ?? 'Failed to add subproject' }));
            } finally {
              topoStore?.close();
            }
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          }
        });
        return;
      }

      // REST API: remove a subproject
      if (req.method === 'DELETE' && url.pathname === '/api/projects/subprojects') {
        const name = url.searchParams.get('name');
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name parameter is required' }));
          return;
        }

        try {
          let topoStore: InstanceType<typeof TopologyStore> | undefined;
          try {
            if (fs.existsSync(TOPOLOGY_DB_PATH)) topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
          } catch { /* subproject support is optional */ }

          if (!topoStore) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No subproject data' }));
            return;
          }

          try {
            const manager = new SubprojectManager(topoStore);
            const removed = manager.remove(name);
            if (removed) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `Subproject '${name}' not found` }));
            }
          } finally {
            topoStore.close();
          }
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Subproject delete failed' }));
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
          const absRoot = path.resolve(root);
          const dangerReason = isDangerousProjectRoot(absRoot);
          if (dangerReason) {
            logger.warn(
              { root: absRoot, reason: dangerReason, ua: req.headers['user-agent'] },
              'Rejected dangerous project root — likely an MCP client spawned trace-mcp with cwd=/ or similar',
            );
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: `Refusing to register "${absRoot}" as a project: ${dangerReason}. Configure a "cwd" on the MCP server entry pointing at a specific source directory.`,
            }));
            return;
          }

          const ancestor = resolveRegisteredAncestor(absRoot);
          if (ancestor && ancestor.root !== absRoot) {
            if (!projectManager.getProject(ancestor.root)) {
              await projectManager.addProject(ancestor.root);
              subscribeToProjectProgress(ancestor.root);
            }
            logger.info({ requested: absRoot, parent: ancestor.root }, 'Routing subdirectory request to registered parent project');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'using_parent', project: ancestor.root, requested: absRoot }));
            return;
          }

          await projectManager.addProject(absRoot);
          subscribeToProjectProgress(absRoot);
          broadcastEvent({ type: 'project_status', project: absRoot, status: 'indexing' });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'added', project: absRoot }));
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
          const { id, project, transport: t, name } = JSON.parse(body.toString()) as { id: string; project: string; transport: string; name?: string };
          const now = new Date().toISOString();
          clients.set(id, { id, name, project, transport: t || 'stdio', connectedAt: now, lastSeen: now });
          broadcastEvent({ type: 'client_connect', clientId: id, transport: t || 'stdio', project, name });
          idleMonitor.onActivity();
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'registered' }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'Bad request' }));
        }
        return;
      }

      // REST API: update client info (e.g. name after MCP initialize)
      if (req.method === 'PATCH' && url.pathname === '/api/clients') {
        try {
          const body = await collectBody(req);
          const { id, name } = JSON.parse(body.toString()) as { id: string; name?: string };
          const existing = clients.get(id);
          if (existing) {
            if (name) existing.name = name;
            existing.lastSeen = new Date().toISOString();
            broadcastEvent({ type: 'client_update' as any, clientId: id, name, project: existing.project });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'updated' }));
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
          idleMonitor.onActivity();
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

      // REST API: AI activity — recent AI requests with timing/status
      if (req.method === 'GET' && url.pathname === '/api/ai/activity') {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          entries: aiTracker.getRecent(limit),
          stats: aiTracker.getStats(),
        }));
        return;
      }

      // REST API: Ask — resolve LLM provider for a project
      if (req.method === 'GET' && url.pathname === '/api/ask/provider') {
        const projectRoot = url.searchParams.get('project');
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?project= parameter' }));
          return;
        }
        const managed = projectManager.getProject(projectRoot);
        if (!managed || managed.status !== 'ready') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found or not ready' }));
          return;
        }
        try {
          const { resolveProvider } = await import('./ai/ask-shared.js');
          // Reload config from disk so we pick up settings changed via the UI
          const freshConfig = (await loadConfig(projectRoot));
          const config = freshConfig.isOk() ? freshConfig.value : managed.config;
          const provider = resolveProvider({}, config);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ provider: provider.name }));
        } catch (e: any) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message ?? 'No provider available' }));
        }
        return;
      }

      // REST API: Ask — stream LLM response with code context
      if (req.method === 'POST' && url.pathname === '/api/ask') {
        const projectRoot = url.searchParams.get('project');
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing ?project= parameter' }));
          return;
        }
        const managed = projectManager.getProject(projectRoot);
        if (!managed || managed.status !== 'ready') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found or not ready' }));
          return;
        }

        let body: { messages?: { role: string; content: string }[]; model?: string; provider?: string; budget?: number };
        try {
          const raw = await collectBody(req);
          body = JSON.parse(raw.toString());
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        const messages = body.messages;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'messages array is required' }));
          return;
        }

        // Find the latest user message for context retrieval
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        if (!lastUserMsg) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No user message found' }));
          return;
        }

        // Start SSE response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const sendEvent = (data: Record<string, unknown>) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        try {
          const { resolveProvider, gatherContext, buildSystemPrompt, stripContextFromMessage } = await import('./ai/ask-shared.js');
          const freshConfig = (await loadConfig(projectRoot));
          const config = freshConfig.isOk() ? freshConfig.value : managed.config;
          const provider = resolveProvider(
            { model: body.model, provider: body.provider },
            config,
          );

          // Phase 1: Retrieve context
          sendEvent({ type: 'phase', phase: 'retrieving' });
          const budget = body.budget ?? 12000;
          const context = await gatherContext(
            projectRoot, managed.store, managed.registry, lastUserMsg.content, budget,
          );

          // Phase 2: Build message array for LLM
          sendEvent({ type: 'phase', phase: 'streaming' });
          const systemMsg = { role: 'system' as const, content: buildSystemPrompt(projectRoot) };
          const chatMessages = [
            systemMsg,
            // Strip context from older user messages
            ...messages.slice(0, -1).map(m => stripContextFromMessage(m as any)),
            // Latest user message with fresh context
            {
              role: 'user' as const,
              content: `## Code Context\n\n${context}\n\n## Question\n\n${lastUserMsg.content}`,
            },
          ];

          // Keep history manageable
          while (chatMessages.length > 21) {
            chatMessages.splice(1, 2);
          }

          // Phase 3: Stream LLM response
          for await (const chunk of provider.streamChat(chatMessages, { maxTokens: 4096 })) {
            sendEvent({ type: 'chunk', content: chunk });
          }

          sendEvent({ type: 'done' });
        } catch (e: any) {
          sendEvent({ type: 'error', message: e?.message ?? 'Unknown error' });
        }

        res.end();
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
      // Dispose all session handles (flush journals, close owned resources)
      for (const h of sessionHandles.values()) {
        h.dispose();
        h.server.close().catch(() => {});
      }
      sessionHandles.clear();
      sessionClients.clear();
      // Close all session transports
      for (const transport of sessionTransports.values()) {
        await transport.close().catch(() => {});
      }
      sessionTransports.clear();
      projectSessions.clear();
      resourcePool.disposeAll();
      idleMonitor.stop();
      clearInterval(activityPoker);
      await projectManager.shutdown();
      httpServer.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn({ port }, 'Port in use — another daemon instance is already running, exiting');
        process.exit(2);
      }
      logger.error({ err: String(err) }, 'httpServer error');
      process.exit(1);
    });

    // ── Idle-exit monitor ───────────────────────────────────────
    // When launched by launchd (KeepAlive=true), idle-exit would cause an
    // immediate respawn loop — disable in that case. Otherwise default 15 min.
    const managedByLaunchd = process.env.TRACE_MCP_MANAGED_BY === 'launchd';
    const defaultIdleMinutes = managedByLaunchd ? 0 : 15;
    const configuredIdleMinutes = typeof globalRaw.daemon_idle_exit_minutes === 'number'
      ? globalRaw.daemon_idle_exit_minutes
      : defaultIdleMinutes;
    const idleMonitor = new DaemonIdleMonitor({
      idleTimeoutMs: configuredIdleMinutes * 60_000,
      isBusy: () => clients.size > 0 || sessionTransports.size > 0 || sseConnections.size > 0,
      onIdle: async () => {
        await shutdown();
      },
    });
    // Track activity: wrap the client/session/SSE mutation points in-place via
    // a ticker that re-evaluates on every /health check (cheap, idempotent).
    // Plus explicit hook below on key mutations.
    const activityPoker = setInterval(() => idleMonitor.onActivity(), 10_000);
    activityPoker.unref();
    // Arm once on startup — daemon starts idle until the first client connects.
    idleMonitor.onActivity();

    // ── Self-staleness detection ─────────────────────────────────
    // A long-running daemon would otherwise stay on the version it booted with
    // until someone manually kills it. checkAndInstallUpdate only runs at
    // startup. To catch external upgrades (stdio session's npm install -g,
    // postinstall hook, or Electron tab), periodically compare our bundled
    // version with the installed package.json on disk. On mismatch we shut
    // down and let the supervisor (launchd KeepAlive / tray watchdog) respawn
    // with the fresh binary. Cheap (one fs read every 10 min, sync but tiny).
    if (PKG_VERSION !== '0.0.0-dev') {
      let pkgPath: string | null = null;
      try {
        pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
      } catch { /* unresolvable (e.g. bundled into a single file) — skip */ }
      if (pkgPath) {
        const stalenessTimer = setInterval(() => {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath!, 'utf-8')) as { version?: string };
            if (pkg.version && pkg.version !== PKG_VERSION) {
              logger.info(
                { running: PKG_VERSION, installed: pkg.version },
                'Installed version changed — shutting down so supervisor respawns with fresh binary',
              );
              void shutdown();
            }
          } catch { /* transient read error — try again next tick */ }
        }, 10 * 60_000);
        stalenessTimer.unref();
      }
    }

    httpServer.listen(port, host, () => {
      const projectCount = projectManager.listProjects().length;
      logger.info({
        host, port, projectCount,
        endpoint: `http://${host}:${port}/mcp`,
        idleExitMinutes: configuredIdleMinutes,
        managedByLaunchd,
      }, 'trace-mcp daemon started');
    });
  });

program
  .command('index')
  .description('Index a project directory')
  .argument('[dir]', 'Directory to index (default: current directory)')
  .option('-f, --force', 'Force reindex all files')
  .action(async (dir: string | undefined, opts: { force?: boolean }) => {
    const resolvedDir = path.resolve(dir ?? '.');
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

    // Auto-discover subprojects: register this project, scan contracts & client calls
    runSubprojectAutoSync(resolvedDir, config);

    await pipeline.dispose();
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
    await pipeline.dispose();
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
program.addCommand(subprojectCommand);
program.addCommand(memoryCommand);
program.addCommand(analyticsCommand);
program.addCommand(statusCommand);
program.addCommand(visualizeCommand);
program.addCommand(daemonCommand);
program.addCommand(installAppCommand);
program.addCommand(askCommand);
program.addCommand(exportSecurityContextCommand);

program.parse();
