#!/usr/bin/env node

// Harden the stdio transport BEFORE any other module import — once a native
// binding (better-sqlite3, parcel/watcher) or a deprecation warning writes a
// stray byte to stdout the JSON-RPC framing is corrupted for the entire
// session. We force UTF-8 and route stdout writes to stderr until the MCP
// server is wired (see src/server/transport-hardening.ts).
import { hardenStdio } from './server/transport-hardening.js';

if (process.argv.includes('serve') || process.argv.length === 2) {
  hardenStdio();
}

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

declare const PKG_VERSION_INJECTED: string;
const PKG_VERSION =
  typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';

import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { aiTracker } from './ai/index.js';
import { detectCoverageRecursive } from './analytics/tech-detector.js';
import { addCommand } from './cli/add.js';
import { analyticsCommand, benchmarkCommand } from './cli/analytics.js';
import { askCommand } from './cli/ask.js';
import { bundlesCommand } from './cli/bundles.js';
import { checkCommand } from './cli/check.js';
import { clientsCommand } from './cli/clients.js';
import { ciReportCommand } from './cli/ci.js';
import { daemonCommand } from './cli/daemon.js';
import { consentCommand } from './cli/consent.js';
import { detectLlmCommand } from './cli/detect-llm.js';
import { doctorCommand } from './cli/doctor.js';
import { evalCommand } from './cli/eval.js';
import { exportSecurityContextCommand } from './cli/export-security-context.js';
import { initCommand } from './cli/init.js';
import { installAppCommand } from './cli/install-app.js';
import { memoryCommand } from './cli/memory.js';
import { removeCommand } from './cli/remove.js';
import { searchCommand } from './cli/search.js';
import { statusCommand } from './cli/status.js';
import { subprojectCommand } from './cli/subproject.js';
import { upgradeCommand } from './cli/upgrade.js';
import { visualizeCommand } from './cli/visualize.js';
import type { TraceMcpConfig } from './config.js';
import { loadConfig, loadGlobalConfigRaw, validateConfigUpdate } from './config.js';
import { isDaemonRunning } from './daemon/client.js';
import { DaemonIdleMonitor } from './daemon/idle-monitor.js';
import { ProjectManager } from './daemon/project-manager.js';
import type { ManagedProject } from './daemon/project-manager.js';
import { handleReindexFile } from './daemon/reindex-file-handler.js';
import { StdioSession } from './daemon/router/session.js';
import { initializeDatabase } from './db/schema.js';
import { Store } from './db/store.js';
import {
  DAEMON_LOG_PATH,
  DEFAULT_DAEMON_PORT,
  ensureGlobalDirs,
  GLOBAL_CONFIG_PATH,
  getDbPath,
  TOPOLOGY_DB_PATH,
} from './global.js';
import { IndexingPipeline } from './indexer/pipeline.js';
import {
  installGuardHook,
  installLifecycleHooks,
  uninstallGuardHook,
  uninstallLifecycleHooks,
} from './init/hooks.js';
import { attachFileLogging, logger } from './logger.js';
import { ensureInitialized, warmUpGrammars } from './parser/tree-sitter.js';
import { PluginRegistry } from './plugin-api/registry.js';
import {
  detectGitWorktree,
  discoverChildProjectsRecursive,
  findProjectRoot,
  hasRootMarkers,
} from './project-root.js';
import { isDangerousProjectRoot, setupProject } from './project-setup.js';
import { getProject, listProjects, resolveRegisteredAncestor } from './registry.js';
import { resolveProjectForMcpRequest } from './daemon/mcp-project-router.js';
import { teardownProjectBookkeeping as teardownProjectBookkeepingImpl } from './daemon/project-bookkeeping.js';
import {
  clearKeyForTerminalEvent as clearProgressKeyForTerminalEvent,
  maybePruneOnHighWatermark as maybePruneProgressThrottle,
  shouldEmitThrottledEvent as shouldEmitProgressEvent,
} from './daemon/progress-throttle.js';
import { handleAskSessionsRequest } from './api/ask-sessions-routes.js';
import { handleDashboardRequest } from './api/dashboard-routes.js';
import { handleJournalStatsRequest, type JournalStatsContext } from './api/journal-stats-routes.js';
import { handleMemoryRequest } from './api/memory-routes.js';
import { handleProjectStatsRequest } from './api/project-stats-routes.js';
import { buildJournalEvent, buildJournalSnapshot } from './server/journal-broadcast.js';
import { createServer } from './server/server.js';
import { SubprojectManager } from './subproject/manager.js';
import { buildGraphData, generateHtml } from './tools/analysis/visualize.js';
import { scanCodeSmells } from './tools/quality/code-smells.js';
import { TopologyStore } from './topology/topology-db.js';
import { checkAndInstallUpdate, runPostUpdateMigrations } from './updater.js';
import { atomicWriteJson } from './utils/atomic-write.js';

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
/** Map common file extensions to tree-sitter grammar language IDs. WHY:
 *  Phase 5.2 pre-warms grammars at daemon listen() so the first parse after
 *  cold-start doesn't pay the WASM load cost (~30-80 ms per grammar). */
const WARMUP_EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  php: 'php',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  vue: 'vue',
  ex: 'elixir',
  exs: 'elixir',
};

/** Probe each managed project's DB once for distinct file extensions and
 *  return the resolved tree-sitter language IDs. Best-effort: a project whose
 *  DB hasn't been opened yet contributes nothing and is silently skipped. */
function collectKnownLanguages(projects: ManagedProject[]): string[] {
  const langs = new Set<string>();
  for (const proj of projects) {
    try {
      const rows = proj.db
        .prepare(
          "SELECT DISTINCT lower(substr(path, length(path) - instr(reverse(path), '.') + 2)) AS ext FROM files LIMIT 100",
        )
        .all() as Array<{ ext: string | null }>;
      for (const row of rows) {
        if (!row.ext) continue;
        const lang = WARMUP_EXT_TO_LANG[row.ext];
        if (lang) langs.add(lang);
      }
    } catch {
      /* DB closed / not ready yet — skip */
    }
  }
  return [...langs];
}

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
      logger.info(
        { worktreeRoot: projectRoot, mainRoot: worktreeInfo.mainRoot },
        'Git worktree detected — sharing main repo index',
      );
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
          logger.debug(
            { cwd: indexRoot, resolvedRoot: root },
            'Skipped auto-register: project root is above CWD',
          );
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
    const autoSpawnDaemon =
      process.env.TRACE_MCP_NO_DAEMON === '1' ? false : (config.auto_spawn_daemon ?? true);
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
      try {
        await session.shutdown(reason);
      } catch (err) {
        logger.warn({ err: String(err) }, 'Session shutdown errored');
      }
      process.exit(0);
    };

    process.on('SIGINT', () => {
      void shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM');
    });
    // Orphan prevention: when the MCP client exits, stdin closes.
    process.stdin.on('end', () => {
      void shutdown('stdin-end');
    });
    process.stdin.on('close', () => {
      void shutdown('stdin-close');
    });

    logger.info(
      { projectRoot, indexRoot, idleTimeoutMs, daemonStabilityMs },
      'Starting trace-mcp stdio session...',
    );
    await session.bootstrap();
    // session.bootstrap() called stdio.start() which resolves when stdin closes.
    // The process stays alive on the stdin event loop; shutdown handlers above
    // take care of exit.
  });

program
  .command('serve-http')
  .description(
    'Start MCP server (HTTP/SSE transport) — daemon mode, indexes all registered projects',
  )
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

    // Phase 5.1: defer registered-project loading until AFTER httpServer.listen
    // so the daemon is reachable from the first millisecond. Requests against
    // a still-indexing project get 503 + Retry-After and the hook falls back
    // to the local CLI path transparently. See plan-next-optimizations §5.1.
    const projectManager = new ProjectManager();

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
    // R09 v2 extends this union with pipeline-lifecycle variants
    // (reindex_*, embed_*, snapshot_created). No new event bus is
    // introduced — all variants flow through the existing
    // broadcastEvent() function below. Single source of truth.
    type DaemonEvent =
      | {
          type: 'indexing_progress';
          project: string;
          pipeline: string;
          phase: string;
          processed: number;
          total: number;
        }
      | { type: 'project_status'; project: string; status: string; error?: string }
      | {
          type: 'client_connect';
          clientId: string;
          project: string;
          transport?: string;
          name?: string;
        }
      | { type: 'client_update'; clientId: string; project?: string; name?: string }
      | { type: 'client_disconnect'; clientId: string; project?: string }
      | {
          type: 'journal_entry';
          project: string;
          ts: number;
          tool: string;
          params_summary: string;
          result_count: number;
          result_tokens?: number;
          latency_ms?: number;
          is_error: boolean;
          session_id: string;
        }
      // ── R09 v2: pipeline-lifecycle variants ──────────────────
      | {
          type: 'reindex_started';
          project: string;
          pipeline: string;
          total_files?: number;
        }
      | {
          type: 'reindex_completed';
          project: string;
          pipeline: string;
          duration_ms: number;
          summary?: Record<string, unknown>;
        }
      | {
          type: 'reindex_errored';
          project: string;
          pipeline: string;
          message: string;
        }
      | { type: 'embed_started'; project: string; total?: number }
      | { type: 'embed_progress'; project: string; processed: number; total: number }
      | {
          type: 'embed_completed';
          project: string;
          duration_ms: number;
          embedded: number;
        }
      | {
          type: 'snapshot_created';
          project: string;
          name: string;
          summary?: Record<string, unknown>;
        };

    const sseConnections = new Set<http.ServerResponse>();

    // Per-(project, pipeline) timestamps for the 200 ms progress throttle.
    // Terminal events (reindex_completed, reindex_errored, embed_completed,
    // snapshot_created) are never throttled.
    const PROGRESS_THROTTLE_MS = 200;
    const lastProgressEmittedAt = new Map<string, number>();

    function broadcastEvent(event: DaemonEvent): void {
      const now = Date.now();
      // Passive sweep: drop stale throttle keys when the map crosses the soft
      // cap. Cheap (no timer, runs inline at most once per event).
      maybePruneProgressThrottle(lastProgressEmittedAt, now);
      // Throttle floor for high-frequency progress variants. Keyed by
      // (project, pipeline) for indexing_progress and (project, 'embed')
      // for embed_progress. Other variants bypass the floor.
      if (!shouldEmitProgressEvent(lastProgressEmittedAt, event, now, PROGRESS_THROTTLE_MS)) {
        return;
      }
      // Terminal pipeline events: drop the throttle key so finished pipelines
      // do not pin entries inside an active (non-removed) project.
      clearProgressKeyForTerminalEvent(lastProgressEmittedAt, event);
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const res of sseConnections) {
        try {
          res.write(data);
        } catch {
          sseConnections.delete(res);
        }
      }
    }

    // Subscribe to progress updates from all managed projects.
    // Keyed by project root so removeProject() can tear down the listener
    // (it otherwise pins the project's ProgressState — and through the
    // listener closure, broadcastEvent + project root — forever).
    const progressUnsubscribers = new Map<string, () => void>();
    function subscribeToProjectProgress(root: string): void {
      const managed = projectManager.getProject(root);
      if (!managed) return;
      // Defensive: drop any prior listener for this root before replacing it
      // (re-add of the same project must not double-subscribe).
      progressUnsubscribers.get(root)?.();
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
      progressUnsubscribers.set(root, unsub);
    }

    /**
     * Tear down all daemon-side bookkeeping for a removed project.
     * Pairs with `subscribeToProjectProgress` / addProject paths.
     *
     * Thin wrapper around the unit-tested helper in
     * `daemon/project-bookkeeping.ts` — the helper owns no globals; cli.ts
     * passes in the local maps/sets so the same code path is exercised by
     * both the daemon and the unit tests.
     */
    function teardownProjectBookkeeping(root: string): void {
      teardownProjectBookkeepingImpl(root, {
        progressUnsubscribers,
        lastProgressEmittedAt,
        projectSessions,
        sessionTransports,
        sessionHandles,
        sessionClients,
        clients,
      });
    }

    // Subscribe to all currently loaded projects
    for (const p of projectManager.listProjects()) {
      subscribeToProjectProgress(p.root);
    }

    // Shared project-level resources (TopologyStore, DecisionStore) — avoids per-session SQLite overhead
    const { ProjectResourcePool } = await import('./daemon/resource-pool.js');
    const resourcePool = new ProjectResourcePool();
    // Wire the pool into ProjectManager so stopProject/removeProject force-
    // disposes the project's pool entry (two SQLite handles otherwise leak per
    // removed project for the daemon's lifetime).
    projectManager.setResourcePool(resourcePool);

    // Per-session MCP transports: sessionId → transport
    // Multiple clients can connect to the same project simultaneously.
    const sessionTransports = new Map<string, StreamableHTTPServerTransport>();
    // Session handles for cleanup: sessionId → ServerHandle
    const sessionHandles = new Map<string, import('./server/server.js').ServerHandle>();
    // Session → client tracking: sessionId → clientId
    const sessionClients = new Map<string, string>();
    // Reverse lookup: projectRoot → Set<sessionId> (for cleanup)
    const projectSessions = new Map<string, Set<string>>();

    async function createSessionTransport(
      projectRoot: string,
    ): Promise<StreamableHTTPServerTransport | null> {
      const managed = projectManager.getProject(projectRoot);
      if (!managed) return null;

      // Pre-allocate the session id so the journal callback below can stamp
      // each emitted event with the same id the MCP transport will use.
      const sessionId = randomUUID();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });

      // Each session needs its own Server instance since the MCP SDK's Server
      // only supports one transport at a time. All sessions share the same
      // underlying Store/Pipeline/Registry via the managed project.
      // TopologyStore and DecisionStore are shared via resource pool.
      const baseDeps = resourcePool.acquire(projectRoot, managed.config);
      const deps = {
        ...baseDeps,
        sessionId,
        onJournalEntry: (
          data: import('./server/journal-broadcast.js').JournalEntryCallbackData,
        ) => {
          broadcastEvent(
            buildJournalEvent({ ...data, project: projectRoot, session_id: sessionId }),
          );
        },
        // R09 v2: lets MCP tools (embed_repo, snapshot_graph) emit
        // pipeline-lifecycle events through the existing SSE bus.
        // Tagged with the project root so the renderer can filter.
        onPipelineEvent: (event: import('./server/server.js').PipelineLifecycleEvent) => {
          broadcastEvent({ ...event, project: projectRoot } as DaemonEvent);
        },
      };
      const handle = createServer(
        managed.store,
        managed.registry,
        managed.config,
        managed.root,
        managed.progress,
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
      (
        transport as unknown as { __pendingHandle?: import('./server/server.js').ServerHandle }
      ).__pendingHandle = handle;
      (transport as unknown as { __pendingClientId?: string }).__pendingClientId = clientId;

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

    // ── Stale client sweep ───────────────────────────────────────
    // If a stdio-proxy crashes without DELETE /api/clients (kill -9, OOM)
    // and reconnects under a new id, the original `clients` entry never gets
    // cleaned up — onclose only fires for HTTP transports. Sweep entries with
    // lastSeen > 1h on a 10-minute timer. HTTP sessions update lastSeen via
    // PATCH /api/clients during MCP initialize; stdio clients update through
    // the same path. If lastSeen hasn't moved in an hour the proxy is gone.
    const CLIENT_STALE_MS = 60 * 60 * 1000;
    const CLIENT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
    const clientSweep = setInterval(() => {
      const now = Date.now();
      const cutoff = now - CLIENT_STALE_MS;
      for (const [id, client] of clients) {
        const seen = Date.parse(client.lastSeen);
        if (Number.isFinite(seen) && seen < cutoff) {
          clients.delete(id);
          try {
            broadcastEvent({ type: 'client_disconnect', clientId: id, project: client.project });
          } catch {
            /* best-effort */
          }
        }
      }
    }, CLIENT_SWEEP_INTERVAL_MS);
    clientSweep.unref();

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
      res.setHeader(
        'Access-Control-Expose-Headers',
        'X-Graph-Nodes, X-Graph-Edges, X-Graph-Communities',
      );
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

      // MCP endpoint — route by session ID, create new session on initialize.
      //
      // Project resolution precedence (see daemon/mcp-project-router.ts):
      //   1. `?project=` query param.
      //   2. `X-Trace-Project` HTTP header (set by our stdio-proxy as
      //      belt-and-braces against query-string-stripping intermediaries).
      //   3. `params._meta["traceMcp/projectRoot"]` in the JSON-RPC body —
      //      the documented hook for IDE HTTP-MCP integrations.
      //   4. Initialize body: `clientInfo.name` matched against the
      //      registered-client tracking table (unique-match only).
      //   5. Exactly one registered project — use it.
      //   6. Otherwise: 400 (multi) or 404 (none). NEVER silently fall back
      //      to listProjects()[0] — that was the pre-58e25a2 bug.
      if (url.pathname === '/mcp') {
        const projects = projectManager.listProjects();

        // Parse the POST body upfront — the resolver needs to peek at it
        // before the multi-project decision.
        let parsedBody: unknown;
        if (req.method === 'POST') {
          try {
            const body = await collectBody(req);
            if (body.length > 0) {
              parsedBody = JSON.parse(body.toString());
            }
          } catch {
            // Malformed body — let the inner transport handler surface a
            // proper JSON-RPC parse error after project resolution.
          }
        }

        const headerHint = req.headers['x-trace-project'];
        const headerProject = Array.isArray(headerHint) ? headerHint[0] : headerHint;

        const resolution = resolveProjectForMcpRequest({
          queryProject: url.searchParams.get('project'),
          headerProject,
          body: parsedBody,
          projects,
          trackedClients: [...clients.values()],
          isInitializeRequest,
        });

        if (resolution.kind === 'no-projects') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No projects registered' }));
          return;
        }
        if (resolution.kind === 'ambiguous') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error:
                'Multiple projects registered — pass ?project=<absolute-path> on /mcp, ' +
                'set the X-Trace-Project header, or include params._meta["traceMcp/projectRoot"] in the MCP initialize body. ' +
                `Registered roots: ${resolution.registered.join(', ')}`,
            }),
          );
          return;
        }
        if (resolution.via === 'tracked-client') {
          logger.info(
            { projectRoot: resolution.projectRoot },
            'Recovered project from tracked client clientInfo.name',
          );
        }
        const requestedRoot = resolution.projectRoot;

        // Resolve subdirectory requests to the registered parent project so we
        // don't spin up a duplicate index per nested package.
        const ancestor = resolveRegisteredAncestor(requestedRoot);
        const projectRoot = ancestor?.root ?? requestedRoot;

        try {
          // Route by session ID for existing sessions
          const sessionId = req.headers['mcp-session-id'] as string | undefined;
          let transport: StreamableHTTPServerTransport | undefined;

          if (sessionId) {
            transport = getTransportBySessionId(sessionId);
            if (!transport) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  jsonrpc: '2.0',
                  error: { code: -32000, message: 'Session not found' },
                  id: null,
                }),
              );
              return;
            }
          } else if (req.method === 'POST' && isInitializeRequest(parsedBody)) {
            // New session: create transport + server
            transport = (await createSessionTransport(projectRoot)) ?? undefined;
            if (!transport) {
              // Auto-register the project on first MCP connect when the path
              // is plausibly a real project root. This recovers the common
              // case where the daemon was respawned after auto-update and
              // lost its in-memory project list while a stdio session is
              // asking for a perfectly valid project root (or umbrella
              // workspace containing nested projects).
              const canAutoAdd =
                fs.existsSync(projectRoot) &&
                !isDangerousProjectRoot(projectRoot) &&
                (hasRootMarkers(projectRoot) ||
                  discoverChildProjectsRecursive(projectRoot, 3).length > 0);
              if (canAutoAdd && !projectManager.getProject(projectRoot)) {
                try {
                  await projectManager.addProject(projectRoot);
                  subscribeToProjectProgress(projectRoot);
                  broadcastEvent({
                    type: 'project_status',
                    project: projectRoot,
                    status: 'indexing',
                  });
                  logger.info({ projectRoot }, 'Auto-registered project on first MCP connect');
                  transport = (await createSessionTransport(projectRoot)) ?? undefined;
                } catch (err) {
                  logger.warn(
                    { err: String(err), projectRoot },
                    'Auto-register on MCP connect failed',
                  );
                }
              }
              if (!transport) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Project not found: ${projectRoot}` }));
                return;
              }
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
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Session expired, reinitialize required' },
                id: null,
              }),
            );
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
            const pendingHandle = (
              transport as unknown as {
                __pendingHandle?: import('./server/server.js').ServerHandle;
              }
            ).__pendingHandle;
            const pendingClientId = (transport as unknown as { __pendingClientId?: string })
              .__pendingClientId;
            if (pendingHandle) {
              sessionHandles.set(sid, pendingHandle);
              (
                transport as unknown as {
                  __pendingHandle?: import('./server/server.js').ServerHandle;
                }
              ).__pendingHandle = undefined;
            }
            if (pendingClientId) {
              sessionClients.set(sid, pendingClientId);
              (transport as unknown as { __pendingClientId?: string }).__pendingClientId =
                undefined;
            }
          }
        } catch (e) {
          if ((e as Error & { stack?: string })?.message === 'BODY_TOO_LARGE') {
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
        res.end(
          JSON.stringify({
            status: 'ok',
            transport: 'http',
            version: PKG_VERSION,
            uptime: Math.floor((Date.now() - startedAt) / 1000),
            pid: process.pid,
            projects,
          }),
        );
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
          let params: unknown[];

          if (isolated) {
            sql = `SELECT s.id, s.fqn, s.kind, f.path as file_path, s.line_start, s.line_end
                   FROM symbols s
                   JOIN files f ON f.id = s.file_id
                   LEFT JOIN nodes n ON n.ref_id = s.id AND n.node_type = 'symbol'
                   LEFT JOIN edges e_out ON e_out.source_node_id = n.id
                   LEFT JOIN edges e_in ON e_in.target_node_id = n.id
                   WHERE e_out.id IS NULL AND e_in.id IS NULL`;
            params = [];
            if (query) {
              sql += ` AND s.fqn LIKE ?`;
              params.push(`%${query}%`);
            }
            if (kind) {
              sql += ` AND s.kind = ?`;
              params.push(kind);
            }
            sql += ` LIMIT ?`;
            params.push(limit);
          } else {
            sql = `SELECT s.id, s.fqn, s.kind, f.path as file_path, s.line_start, s.line_end
                   FROM symbols s JOIN files f ON f.id = s.file_id WHERE 1=1`;
            params = [];
            if (query) {
              sql += ` AND s.fqn LIKE ?`;
              params.push(`%${query}%`);
            }
            if (kind) {
              sql += ` AND s.kind = ?`;
              params.push(kind);
            }
            sql += ` ORDER BY s.fqn LIMIT ?`;
            params.push(limit);
          }

          const symbols = db.prepare(sql).all(...params);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ symbols, count: symbols.length }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: (e as Error & { stack?: string })?.message ?? 'Query failed' }),
          );
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
          const symbol = db
            .prepare(`
            SELECT s.id, s.fqn, s.kind, f.path as file_path, s.line_start, s.line_end
            FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?
          `)
            .get(symbolId);
          // Find the node for this symbol
          const node = db
            .prepare(`SELECT id FROM nodes WHERE node_type = 'symbol' AND ref_id = ?`)
            .get(symbolId) as Record<string, unknown> | undefined;
          let outgoing: unknown[] = [];
          let incoming: unknown[] = [];
          if (node) {
            outgoing = db
              .prepare(`
              SELECT et.name as type, e.metadata,
                     ts.id, ts.fqn, ts.kind, tf.path as file_path
              FROM edges e
              JOIN edge_types et ON et.id = e.edge_type_id
              JOIN nodes tn ON tn.id = e.target_node_id
              LEFT JOIN symbols ts ON tn.node_type = 'symbol' AND tn.ref_id = ts.id
              LEFT JOIN files tf ON tf.id = ts.file_id
              WHERE e.source_node_id = ?
            `)
              .all(node.id);
            incoming = db
              .prepare(`
              SELECT et.name as type, e.metadata,
                     ss.id, ss.fqn, ss.kind, sf.path as file_path
              FROM edges e
              JOIN edge_types et ON et.id = e.edge_type_id
              JOIN nodes sn ON sn.id = e.source_node_id
              LEFT JOIN symbols ss ON sn.node_type = 'symbol' AND sn.ref_id = ss.id
              LEFT JOIN files sf ON sf.id = ss.file_id
              WHERE e.target_node_id = ?
            `)
              .all(node.id);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ symbol, nodeId: node?.id ?? null, outgoing, incoming }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: (e as Error & { stack?: string })?.message ?? 'Query failed' }),
          );
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
          const layout = (url.searchParams.get('layout') ?? 'force') as
            | 'force'
            | 'hierarchical'
            | 'radial';
          const hideIsolated = url.searchParams.get('hideIsolated') !== 'false';
          const symbolKinds = url.searchParams.get('symbolKinds')?.split(',').filter(Boolean);
          const maxFiles = url.searchParams.has('maxFiles')
            ? parseInt(url.searchParams.get('maxFiles')!, 10)
            : undefined;
          const maxNodes = url.searchParams.has('maxNodes')
            ? parseInt(url.searchParams.get('maxNodes')!, 10)
            : undefined;
          const includeBottlenecks = url.searchParams.get('includeBottlenecks') === 'true';

          // Open topoStore for subproject support (best-effort)
          let topoStore: InstanceType<typeof TopologyStore> | undefined;
          try {
            if (fs.existsSync(TOPOLOGY_DB_PATH)) topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
          } catch {
            /* subproject support is optional */
          }

          try {
            const { nodes, edges, communities } = buildGraphData(managed.store, {
              scope,
              depth,
              granularity,
              layout,
              hideIsolated,
              symbolKinds,
              maxFiles,
              maxNodes,
              topoStore,
              projectRoot,
              includeBottlenecks,
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ nodes, edges, communities }));
          } finally {
            topoStore?.close();
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: (e as Error & { stack?: string })?.message ?? 'Graph build failed',
            }),
          );
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
          const layout = (url.searchParams.get('layout') ?? 'force') as
            | 'force'
            | 'hierarchical'
            | 'radial';
          const hideIsolated = url.searchParams.get('hideIsolated') !== 'false';
          const symbolKinds = url.searchParams.get('symbolKinds')?.split(',').filter(Boolean);
          const maxFiles = url.searchParams.has('maxFiles')
            ? parseInt(url.searchParams.get('maxFiles')!, 10)
            : undefined;
          const maxNodes = url.searchParams.has('maxNodes')
            ? parseInt(url.searchParams.get('maxNodes')!, 10)
            : undefined;
          const highlightDepth = url.searchParams.has('highlightDepth')
            ? parseInt(url.searchParams.get('highlightDepth')!, 10)
            : undefined;

          // Open topoStore for subproject support (best-effort)
          let topoStore: InstanceType<typeof TopologyStore> | undefined;
          try {
            if (fs.existsSync(TOPOLOGY_DB_PATH)) topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
          } catch {
            /* subproject support is optional */
          }

          try {
            const { nodes, edges, communities } = buildGraphData(managed.store, {
              scope,
              depth,
              granularity,
              layout,
              hideIsolated,
              symbolKinds,
              maxFiles,
              maxNodes,
              topoStore,
              projectRoot,
              highlightDepth,
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
              html = html.replace('</head>', `${embeddedCSS}</head>`);
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
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end((e as Error & { stack?: string })?.message ?? 'Graph build failed');
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
          const totalSymbols =
            (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number })?.c ?? 0;
          const totalEdges =
            (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number })?.c ?? 0;
          const isolatedCount =
            (
              db
                .prepare(`
            SELECT COUNT(*) as c FROM symbols s
            WHERE NOT EXISTS (
              SELECT 1 FROM nodes n
              JOIN edges e ON e.source_node_id = n.id OR e.target_node_id = n.id
              WHERE n.node_type = 'symbol' AND n.ref_id = s.id
            )
          `)
                .get() as { c: number } | undefined
            )?.c ?? 0;

          const kindBreakdown = db
            .prepare(
              'SELECT kind, COUNT(*) as count FROM symbols GROUP BY kind ORDER BY count DESC',
            )
            .all();
          const edgeBreakdown = db
            .prepare(`
            SELECT et.name as type, COUNT(*) as count
            FROM edges e JOIN edge_types et ON et.id = e.edge_type_id
            GROUP BY et.name ORDER BY count DESC
          `)
            .all();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              totalSymbols,
              totalEdges,
              isolatedCount,
              kindBreakdown,
              edgeBreakdown,
            }),
          );
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: (e as Error & { stack?: string })?.message ?? 'Query failed' }),
          );
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
          const files =
            (db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number })?.c ?? 0;
          const symbols =
            (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number })?.c ?? 0;
          const edges =
            (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number })?.c ?? 0;
          const lastRow = db.prepare('SELECT MAX(indexed_at) as t FROM files').get() as
            | { t: string | null }
            | undefined;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ files, symbols, edges, lastIndexed: lastRow?.t ?? null }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: (e as Error & { stack?: string })?.message ?? 'Failed to get stats',
            }),
          );
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
          ? categoryParam
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean)
          : undefined;
        const priorityThreshold = url.searchParams.get('priority_threshold') ?? undefined;
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '500', 10), 2000);
        try {
          type SmellOpts = NonNullable<Parameters<typeof scanCodeSmells>[2]>;
          const result = scanCodeSmells(managed.store, projectRoot, {
            category: categories as SmellOpts['category'],
            priority_threshold: priorityThreshold as SmellOpts['priority_threshold'],
            limit,
          });
          if (result.isErr()) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(result.error) }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.value));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: (e as Error & { stack?: string })?.message ?? 'Failed to scan code smells',
            }),
          );
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
              if (
                !existing ||
                (needPrio[u.needs_plugin] ?? 3) < (needPrio[existing.needs_plugin] ?? 3)
              ) {
                unknownMap.set(u.name, u);
              }
            }
          }
          const unknown = [...unknownMap.values()].sort(
            (a, b) => (needPrio[a.needs_plugin] ?? 3) - (needPrio[b.needs_plugin] ?? 3),
          );

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              coverage: {
                total_significant: multi.aggregate.total_significant,
                covered: multi.aggregate.covered,
                coverage_pct: multi.aggregate.coverage_pct,
              },
              gaps,
              unknown,
            }),
          );
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: (e as Error & { stack?: string })?.message ?? 'Failed to detect coverage',
            }),
          );
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

          const files = db.prepare(sql).all(...scopeParams, limit) as {
            path: string;
            symbols: number;
            edges: number;
          }[];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ files, sort: sortBy }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: (e as Error & { stack?: string })?.message ?? 'Query failed' }),
          );
        }
        return;
      }

      // REST API: list subprojects for a project
      if (req.method === 'GET' && url.pathname === '/api/projects/subprojects') {
        try {
          let topoStore: InstanceType<typeof TopologyStore> | undefined;
          try {
            if (fs.existsSync(TOPOLOGY_DB_PATH)) topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
          } catch {
            /* subproject support is optional */
          }

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
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: (e as Error & { stack?: string })?.message ?? 'Subproject query failed',
            }),
          );
        }
        return;
      }

      // REST API: update service project_group
      if (req.method === 'PATCH' && url.pathname === '/api/projects/services') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const { serviceId, projectGroup } = JSON.parse(body) as {
              serviceId: number;
              projectGroup: string | null;
            };
            if (serviceId == null) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'serviceId is required' }));
              return;
            }

            let topoStore: InstanceType<typeof TopologyStore> | undefined;
            try {
              ensureGlobalDirs();
              topoStore = new TopologyStore(TOPOLOGY_DB_PATH);
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: (e as Error & { stack?: string })?.message ?? 'Failed to open topology DB',
                }),
              );
              return;
            }

            try {
              topoStore.updateServiceGroup(serviceId, projectGroup ?? null);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } finally {
              topoStore.close();
            }
          } catch (_e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          }
        });
        return;
      }

      // REST API: add a subproject to a project
      if (req.method === 'POST' && url.pathname === '/api/projects/subprojects') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
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
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: (e as Error & { stack?: string })?.message ?? 'Failed to open topology DB',
                }),
              );
              return;
            }

            try {
              const manager = new SubprojectManager(topoStore);
              const result = manager.add(repoPath, project);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: (e as Error & { stack?: string })?.message ?? 'Failed to add subproject',
                }),
              );
            } finally {
              topoStore?.close();
            }
          } catch (_e) {
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
          } catch {
            /* subproject support is optional */
          }

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
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: (e as Error & { stack?: string })?.message ?? 'Subproject delete failed',
            }),
          );
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
        // R09 v2: lifecycle events around the reindex call.
        // started is fire-and-forget; completed/errored fire on the
        // async settlement of the pipeline promise.
        const reindexStartedAt = Date.now();
        broadcastEvent({
          type: 'reindex_started',
          project: projectRoot,
          pipeline: 'index',
        });
        managed.pipeline
          .indexAll(true)
          .then((result) => {
            broadcastEvent({
              type: 'reindex_completed',
              project: projectRoot,
              pipeline: 'index',
              duration_ms: Date.now() - reindexStartedAt,
              summary: result as unknown as Record<string, unknown>,
            });
          })
          .catch((err) => {
            logger.error({ error: err, projectRoot }, 'Reindex failed');
            broadcastEvent({
              type: 'reindex_errored',
              project: projectRoot,
              pipeline: 'index',
              message: err instanceof Error ? err.message : String(err),
            });
          });
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'reindex_started', project: projectRoot }));
        return;
      }

      // REST API: incremental single-file reindex (called by the PostToolUse hook
      // and by `trace-mcp index-file` once the daemon is up — see plan-indexer-perf §1.1).
      if (req.method === 'POST' && url.pathname === '/api/projects/reindex-file') {
        let parsed: { project?: string; path?: string };
        try {
          const body = await collectBody(req);
          parsed = JSON.parse(body.toString()) as { project?: string; path?: string };
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `invalid JSON body: ${(e as Error).message}` }));
          return;
        }
        const result = await handleReindexFile(parsed, {
          getProject: (root) => projectManager.getProject(root),
        });
        if (!result.ok) {
          // WHY Retry-After: the 503 branch fires when a project is still warming
          // on a cold daemon. Hook clients honour Retry-After and fall back to the
          // local CLI path transparently.
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (result.status === 503) {
            headers['Retry-After'] = String(result.retryAfterSec);
          }
          res.writeHead(result.status, headers);
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      // GET /api/stats — daemon reindex telemetry summary (optional ?since=1h)
      if (req.method === 'GET' && url.pathname === '/api/stats') {
        try {
          const { getReindexStats } = await import('./daemon/reindex-stats.js');
          const { parseDuration } = await import('./cli/daemon-stats.js');
          const sinceParam = url.searchParams.get('since');
          let sinceMs: number | undefined;
          if (sinceParam) {
            const parsed = parseDuration(sinceParam);
            if (parsed == null) {
              // Phase 5+7 audit fix: align with `daemon stats` CLI which exits
              // non-zero on bad duration. Silently falling back to all-time
              // hides a malformed query — return 400 instead.
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: `invalid 'since' duration: ${sinceParam}. Use s/m/h/d suffix (e.g. 1h, 24h, 7d).`,
                }),
              );
              return;
            }
            sinceMs = parsed;
          }
          const summary = getReindexStats().summarize(sinceMs);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(summary));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
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
            res.end(
              JSON.stringify({
                error: `Refusing to register "${absRoot}" as a project: ${dangerReason}. Configure a "cwd" on the MCP server entry pointing at a specific source directory.`,
              }),
            );
            return;
          }

          const ancestor = resolveRegisteredAncestor(absRoot);
          if (ancestor && ancestor.root !== absRoot) {
            if (!projectManager.getProject(ancestor.root)) {
              await projectManager.addProject(ancestor.root);
              subscribeToProjectProgress(ancestor.root);
            }
            logger.info(
              { requested: absRoot, parent: ancestor.root },
              'Routing subdirectory request to registered parent project',
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                status: 'using_parent',
                project: ancestor.root,
                requested: absRoot,
              }),
            );
            return;
          }

          await projectManager.addProject(absRoot);
          subscribeToProjectProgress(absRoot);
          broadcastEvent({ type: 'project_status', project: absRoot, status: 'indexing' });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'added', project: absRoot }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: (e as Error & { stack?: string })?.message ?? 'Failed to add project',
            }),
          );
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
        // Tear down progress listener, sessions, throttle keys, etc. for
        // this root BEFORE we emit the status event so listeners on the
        // SSE bus see a clean state.
        teardownProjectBookkeeping(projectRoot);
        broadcastEvent({ type: 'project_status', project: projectRoot, status: 'removed' });
        // Clean up any remaining client entries for this project (transport
        // onclose handlers typically already removed these via the teardown
        // above; this is a belt-and-braces sweep for stdio-registered clients
        // that aren't tied to an HTTP session).
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
          const {
            id,
            project,
            transport: t,
            name,
          } = JSON.parse(body.toString()) as {
            id: string;
            project: string;
            transport: string;
            name?: string;
          };
          const now = new Date().toISOString();
          clients.set(id, {
            id,
            name,
            project,
            transport: t || 'stdio',
            connectedAt: now,
            lastSeen: now,
          });
          broadcastEvent({
            type: 'client_connect',
            clientId: id,
            transport: t || 'stdio',
            project,
            name,
          });
          idleMonitor.onActivity();
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'registered' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: (e as Error & { stack?: string })?.message ?? 'Bad request' }),
          );
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
            broadcastEvent({
              type: 'client_update',
              clientId: id,
              name,
              project: existing.project,
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'updated' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: (e as Error & { stack?: string })?.message ?? 'Bad request' }),
          );
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
        res.end(
          JSON.stringify({
            settings: raw,
            path: GLOBAL_CONFIG_PATH,
            daemon: {
              port,
              host,
              log_path: DAEMON_LOG_PATH,
              uptime: Math.floor((Date.now() - startedAt) / 1000),
              pid: process.pid,
            },
          }),
        );
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
          atomicWriteJson(GLOBAL_CONFIG_PATH, merged);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'updated', settings: merged }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: (e as Error & { stack?: string })?.message ?? 'Invalid JSON body',
            }),
          );
        }
        return;
      }

      // REST API: AI activity — recent AI requests with timing/status
      if (req.method === 'GET' && url.pathname === '/api/ai/activity') {
        const limit = Math.min(
          Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1),
          200,
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            entries: aiTracker.getRecent(limit),
            stats: aiTracker.getStats(),
          }),
        );
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
          const freshConfig = await loadConfig(projectRoot);
          const config = freshConfig.isOk() ? freshConfig.value : managed.config;
          const provider = resolveProvider({}, config);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ provider: provider.name }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: (e as Error & { stack?: string })?.message ?? 'No provider available',
            }),
          );
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

        let body: {
          messages?: { role: string; content: string }[];
          model?: string;
          provider?: string;
          budget?: number;
        };
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
        const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
        if (!lastUserMsg) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No user message found' }));
          return;
        }

        // Start SSE response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const sendEvent = (data: Record<string, unknown>) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        try {
          const { resolveProvider, gatherContext, buildSystemPrompt, stripContextFromMessage } =
            await import('./ai/ask-shared.js');
          const freshConfig = await loadConfig(projectRoot);
          const config = freshConfig.isOk() ? freshConfig.value : managed.config;
          const provider = resolveProvider({ model: body.model, provider: body.provider }, config);

          // Phase 1: Retrieve context
          sendEvent({ type: 'phase', phase: 'retrieving' });
          const budget = body.budget ?? 12000;
          const context = await gatherContext(
            projectRoot,
            managed.store,
            managed.registry,
            lastUserMsg.content,
            budget,
          );

          // Phase 2: Build message array for LLM
          sendEvent({ type: 'phase', phase: 'streaming' });
          const systemMsg = { role: 'system' as const, content: buildSystemPrompt(projectRoot) };
          const chatMessages = [
            systemMsg,
            // Strip context from older user messages
            ...messages
              .slice(0, -1)
              .map((m) =>
                stripContextFromMessage(m as Parameters<typeof stripContextFromMessage>[0]),
              ),
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
        } catch (e) {
          sendEvent({
            type: 'error',
            message: (e as Error & { stack?: string })?.message ?? 'Unknown error',
          });
        }

        res.end();
        return;
      }

      // REST API: SSE event stream
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // Send initial snapshot of all project statuses
        for (const p of projectManager.listProjects()) {
          const snap = p.progress.snapshot();
          res.write(
            `data: ${JSON.stringify({
              type: 'project_status',
              project: p.root,
              status: p.status,
              error: p.error,
              progress: snap,
            })}\n\n`,
          );
        }
        sseConnections.add(res);
        req.on('close', () => {
          sseConnections.delete(res);
        });
        // Keep-alive ping every 30s
        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(keepAlive);
            sseConnections.delete(res);
          }
        }, 30_000);
        req.on('close', () => clearInterval(keepAlive));
        return;
      }

      // ── Activity tab — snapshot of recent journal entries for a project ──
      // Live updates flow through /api/events as `journal_entry` events; this
      // endpoint returns the last N entries from the most-recently-active
      // session's journal so the tab can populate on first mount.
      if (req.method === 'GET' && url.pathname === '/api/projects/journal') {
        const projectRoot = url.searchParams.get('project');
        const limit = Math.min(
          1000,
          Math.max(1, parseInt(url.searchParams.get('limit') ?? '200', 10) || 200),
        );
        if (!projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'project query param is required' }));
          return;
        }
        const sids = projectSessions.get(projectRoot);
        let snapshot: ReturnType<typeof buildJournalSnapshot> = [];
        if (sids && sids.size > 0) {
          // Pick the most recently created session (last inserted into the Set).
          const sid = [...sids].pop()!;
          const handle = sessionHandles.get(sid);
          if (handle) {
            snapshot = buildJournalSnapshot(handle.journal, projectRoot, sid, limit);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot));
        return;
      }

      // ── Activity stats — aggregated journal metrics for the Activity tab ─
      const journalStatsCtx: JournalStatsContext = {
        listEntriesForProject(projectRoot) {
          const sids = projectSessions.get(projectRoot);
          if (!sids || sids.size === 0) return [];
          const out: ReturnType<typeof buildJournalSnapshot> = [];
          for (const sid of sids) {
            const handle = sessionHandles.get(sid);
            if (handle) out.push(...buildJournalSnapshot(handle.journal, projectRoot, sid, 10_000));
          }
          return out;
        },
      };
      if (handleJournalStatsRequest(req, res, url, journalStatsCtx)) return;

      // ── Per-project deep-dive stats (Stats modal) ─────────────────────
      if (handleProjectStatsRequest(req, res, url, { journalStats: journalStatsCtx })) return;

      // ── Memory explorer (decisions / corpora / sessions) ──────────────
      if (handleMemoryRequest(req, res, url)) return;

      // ── Dashboard — aggregate health across all registered projects ───
      if (await handleDashboardRequest(req, res)) return;

      // ── Ask v2 — persistent chat sessions with context transparency ───
      if (await handleAskSessionsRequest(req, res, { projectManager, loadConfig })) return;

      res.writeHead(404);
      res.end();
    });

    const shutdown = async () => {
      // Close SSE connections
      for (const res of sseConnections) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      sseConnections.clear();
      // Unsubscribe progress listeners
      for (const unsub of progressUnsubscribers.values()) {
        try {
          unsub();
        } catch {
          /* ignore */
        }
      }
      progressUnsubscribers.clear();
      lastProgressEmittedAt.clear();
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
      clearInterval(rateBucketCleanup);
      clearInterval(clientSweep);
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
    const configuredIdleMinutes =
      typeof globalRaw.daemon_idle_exit_minutes === 'number'
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
      } catch {
        /* unresolvable (e.g. bundled into a single file) — skip */
      }
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
          } catch {
            /* transient read error — try again next tick */
          }
        }, 10 * 60_000);
        stalenessTimer.unref();
      }
    }

    httpServer.listen(port, host, () => {
      const projectCount = projectManager.listProjects().length;
      logger.info(
        {
          host,
          port,
          projectCount,
          endpoint: `http://${host}:${port}/mcp`,
          idleExitMinutes: configuredIdleMinutes,
          managedByLaunchd,
        },
        'trace-mcp daemon started',
      );

      // Phase 5.2: warm tree-sitter init eagerly so the first parse doesn't
      // pay the WASM cold-start tax. Best-effort, fire-and-forget.
      void ensureInitialized().catch(() => {
        /* warm-up failure is non-fatal; lazy path still works */
      });

      // Phase 5.1: kick off registered-project loading in the background.
      // HTTP server is already accepting; in-flight requests against a still-
      // indexing project return 503 (Retry-After: 5) so the hook fallback
      // takes over transparently until indexing completes.
      void (async () => {
        try {
          await projectManager.loadAllRegistered();
        } catch (err) {
          logger.error({ err }, 'loadAllRegistered failed during cold-start');
        }

        // If cwd is a project not yet registered, add it too.
        const cwd = process.cwd();
        if (!projectManager.getProject(cwd)) {
          try {
            const root = findProjectRoot(cwd);
            if (!projectManager.getProject(root)) {
              await projectManager.addProject(root);
            }
          } catch {
            /* cwd is not a project dir — fine */
          }
        }

        // Phase 5.2: now that we have the language set from the registered
        // project DBs, pre-warm the relevant tree-sitter grammars in parallel.
        try {
          const languages = collectKnownLanguages(projectManager.listProjects());
          if (languages.length > 0) {
            void warmUpGrammars(languages).catch(() => {
              /* best-effort warm-up */
            });
          }
        } catch {
          /* never fatal */
        }
      })();
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
    const registry = PluginRegistry.createWithDefaults();

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

    // Daemon-first path: avoids a cold Node + WASM + plugin spawn (~300-500 ms)
    // when the long-running daemon already has everything warm. See plan-indexer-perf §1.1.
    if (await isDaemonRunning(DEFAULT_DAEMON_PORT).catch(() => false)) {
      try {
        const res = await fetch(
          `http://127.0.0.1:${DEFAULT_DAEMON_PORT}/api/projects/reindex-file`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: projectRoot, path: resolvedFile }),
            signal: AbortSignal.timeout(2000),
          },
        );
        if (res.ok) {
          logger.debug(
            { file: resolvedFile, projectRoot, status: res.status },
            'index-file proxied to daemon',
          );
          process.exit(0);
        }
        logger.warn(
          { file: resolvedFile, projectRoot, status: res.status },
          'Daemon reindex-file rejected request — falling back to local indexing',
        );
      } catch (e) {
        logger.warn(
          { file: resolvedFile, projectRoot, err: (e as Error).message },
          'Daemon reindex-file failed — falling back to local indexing',
        );
      }
    }

    const configResult = await loadConfig(projectRoot);
    if (configResult.isErr()) process.exit(0);
    const config = configResult.value;

    const dbPath = resolveDbPath(projectRoot);
    ensureGlobalDirs();

    const db = initializeDatabase(dbPath);
    const store = new Store(db);
    const registry = PluginRegistry.createWithDefaults();

    const pipeline = new IndexingPipeline(store, registry, config, projectRoot);
    await pipeline.indexFiles([resolvedFile]);
    await pipeline.dispose();
    db.close();
  });

program
  .command('setup-hooks')
  .description(
    'Install Claude Code PreToolUse guard + lifecycle hooks (alias: use `trace-mcp init` instead)',
  )
  .option(
    '--global',
    'Install to ~/.claude/settings.json (default: project-level .claude/settings.local.json)',
  )
  .option('--uninstall', 'Remove the hook(s)')
  .option(
    '--lifecycle',
    'Operate on the lifecycle hooks (SessionStart / UserPromptSubmit / Stop / SessionEnd) instead of the guard hook',
  )
  .action((opts: { global?: boolean; uninstall?: boolean; lifecycle?: boolean }) => {
    if (opts.lifecycle) {
      if (opts.uninstall) {
        const removed = uninstallLifecycleHooks({ global: opts.global });
        console.log(`Removed ${removed.length} lifecycle hook entries.`);
        return;
      }
      const installed = installLifecycleHooks({ global: opts.global });
      for (const r of installed) {
        console.log(`Hook ${r.action}: ${r.target}`);
        if (r.detail) console.log(`  ${r.detail}`);
      }
      return;
    }
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
program.addCommand(detectLlmCommand);
program.addCommand(consentCommand);
program.addCommand(ciReportCommand);
program.addCommand(checkCommand);
program.addCommand(clientsCommand);
program.addCommand(bundlesCommand);
program.addCommand(subprojectCommand);
program.addCommand(memoryCommand);
program.addCommand(analyticsCommand);
program.addCommand(benchmarkCommand);
program.addCommand(evalCommand);
program.addCommand(statusCommand);
program.addCommand(visualizeCommand);
program.addCommand(daemonCommand);
program.addCommand(installAppCommand);
program.addCommand(askCommand);
program.addCommand(searchCommand);
program.addCommand(exportSecurityContextCommand);

program.parse();
