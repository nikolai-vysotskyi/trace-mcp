import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { TraceMcpConfig } from '../../config.js';
import { logger } from '../../logger.js';
import { checkVersionDrift, versionDriftMessage } from '../../init/version-stamp.js';
import { stripRedundantSchemaKeyword } from '../../server/schema-shim.js';
import { ClientProfileGate } from '../../server/client-profile.js';
import { createToolFilter } from '../../server/tool-filter.js';
import { disarmStdoutGuard } from '../../server/transport-hardening.js';
import { tryAutoSpawnDaemon } from '../lifecycle.js';
import { PollingDaemonWatcher } from './daemon-watcher.js';
import {
  createHandshakeWatchdog,
  type HandshakeWatchdog,
  resolveHandshakeTimeout,
} from './handshake-watchdog.js';
import { LocalBackend } from './local-backend.js';
import { MessageRouter } from './message-router.js';
import { ProxyBackend } from './proxy-backend.js';
import type { Backend } from './types.js';

declare const PKG_VERSION_INJECTED: string;
const PKG_VERSION =
  typeof PKG_VERSION_INJECTED !== 'undefined' ? PKG_VERSION_INJECTED : '0.0.0-dev';

/**
 * How long a daemon-backed session gets to answer `initialize` before we give
 * up on it and serve the session in-process instead.
 */
const PROXY_INITIALIZE_TIMEOUT_MS = 1_000;

function isInitializeRequest(msg: JSONRPCMessage): boolean {
  const m = msg as Record<string, unknown>;
  return m.method === 'initialize' && m.id !== undefined && m.id !== null;
}

export interface StdioSessionOptions {
  projectRoot: string;
  indexRoot: string;
  config: TraceMcpConfig;
  sharedDbPath: string;
  daemonPort: number;
  daemonUrl?: string;
  /** ms of stdin silence before we release full-mode resources. 0 = disabled. */
  idleTimeoutMs: number;
  /** ms the daemon state must be stable before we accept it. */
  daemonStabilityMs: number;
  /** ms to wait for pending requests to finish during a backend swap. */
  drainTimeoutMs?: number;
  /** If true and no daemon is running, try to spawn one before falling back to local mode. */
  autoSpawnDaemon?: boolean;
  /** ms to wait for an auto-spawned daemon's /health to respond. */
  autoSpawnTimeoutMs?: number;
  /**
   * Wall-clock budget for the MCP client to send its first JSON-RPC frame
   * after stdio comes up. If exceeded, write a one-line diagnostic to stderr
   * pointing at the most common failure modes (stdout-corruption from npm/
   * pnpm/uvx output, wrong binary path). Best-effort — server keeps running.
   * Defaults to env TRACE_MCP_HANDSHAKE_TIMEOUT or 5_000. Set 0 to disable.
   */
  handshakeTimeoutMs?: number;
  /** Overrides for the stdio streams. Defaults to the process's own. */
  stdin?: Readable;
  stdout?: Writable;
}

/**
 * Owns the singleton StdioServerTransport and the MessageRouter.
 * Decides which Backend to run based on daemon availability and orchestrates
 * promote/demote transitions.
 *
 * One StdioSession per process.
 */
export class StdioSession {
  private readonly opts: StdioSessionOptions;
  private readonly clientId = randomUUID();
  private readonly stdio: StdioServerTransport;
  private readonly router: MessageRouter;
  private readonly watcher: PollingDaemonWatcher;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private handshake: HandshakeWatchdog | null = null;
  private readonly pendingBackgroundDisposes = new Set<Promise<void>>();
  private shuttingDown = false;
  private bootstrapped = false;
  /** Tracks the mode we *intend* to have — may differ briefly from router.getActiveKind() during swap. */
  private desiredMode: 'proxy' | 'local' | 'dormant' = 'dormant';
  /** Guards against concurrent wakeUp() calls when multiple stdin messages arrive in the dormant window. */
  private wakePromise: Promise<void> | null = null;
  /**
   * The client's `initialize` frame, cached the moment it arrives. A swapped-in
   * ProxyBackend (local→proxy after daemon recovery) never sees `initialize`
   * again, so we seed it from here — otherwise its first request POSTs
   * session-less and surfaces "Session expired, reinitialize required" (#209).
   */
  private cachedInitialize: JSONRPCMessage | null = null;
  /**
   * Tailors the advertised surface to the connected host (TRA-513). Applied on
   * the wire because both backends build their tool surface and their
   * instructions before `initialize` has been read — this is the only layer that
   * sees the handshake and every frame going back to the client.
   */
  private readonly clientProfile: ClientProfileGate;
  /** Id of the in-flight `initialize` request the watchdog below is timing. */
  private initializeId: string | number | null = null;
  private initializeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set once a daemon has failed to answer `initialize` for this session.
   * Blocks the watcher from swapping us back onto it — a daemon whose /health
   * works while its MCP handler is wedged would otherwise be re-adopted on the
   * next poll and hang the session all over again.
   */
  private proxyDisabled = false;

  constructor(opts: StdioSessionOptions) {
    this.opts = opts;
    this.clientProfile = new ClientProfileGate(opts.config);
    this.stdio = stripRedundantSchemaKeyword(new StdioServerTransport(opts.stdin, opts.stdout));
    this.router = new MessageRouter({
      sendToClient: (msg) => {
        const id = (msg as unknown as { id?: string | number }).id;
        if (id !== undefined && id === this.initializeId) {
          this.clearInitializeWatchdog();
          // A daemon that fails the handshake fast is the same problem as one
          // that never answers, and gets the same answer: swallow its error
          // and replay the handshake locally rather than failing the client.
          if (Object.hasOwn(msg as object, 'error')) {
            void this.fallbackToLocal(id, 'proxy-initialize-error');
            return;
          }
        }
        return this.stdio.send(this.clientProfile.applyToClient(msg) as JSONRPCMessage);
      },
      drainTimeoutMs: opts.drainTimeoutMs ?? 5_000,
    });
    this.watcher = new PollingDaemonWatcher({
      port: opts.daemonPort,
      stabilityMs: opts.daemonStabilityMs,
    });
  }

  /**
   * Start the session: pick initial mode based on daemon state, wire stdio,
   * start the daemon watcher, install idle + lifecycle hooks.
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.bootstrapped = true;

    // Wire the stdio transport so inbound messages go to the router.
    this.stdio.onmessage = (msg) => {
      this.handshake?.observe();
      this.resetIdleTimer();
      // Cache the handshake so a later swapped-in proxy backend can re-establish
      // the daemon session (the client only sends `initialize` once).
      if (isInitializeRequest(msg as JSONRPCMessage)) this.cachedInitialize = msg as JSONRPCMessage;
      this.clientProfile.observeFromClient(msg);
      if (isInitializeRequest(msg as JSONRPCMessage)) {
        logger.info({ profile: this.clientProfile.name }, 'StdioSession: resolved client profile');
        this.armInitializeWatchdog((msg as unknown as { id: string | number }).id);
      }
      void this.router.ingestFromClient(msg as JSONRPCMessage);
    };
    this.stdio.onerror = (err) => {
      logger.warn({ err: String(err) }, 'StdioSession: stdio transport error');
    };

    await this.watcher.start();
    const daemonActive = this.watcher.getCurrentState();

    // Pick a backend from the daemon state we already know. Spawning a daemon
    // is an optimization and must never gate the handshake (TRA-704) — it runs
    // in the background below, and the watcher swaps us onto it when it lands.
    let initialBackend: Backend = daemonActive
      ? this.buildProxyBackend()
      : this.buildLocalBackend();
    try {
      await initialBackend.start();
    } catch (err) {
      if (initialBackend.kind === 'local') throw err;
      // Daemon answered /health but wouldn't take the session — serve this
      // session in-process rather than failing the whole connection.
      logger.warn(
        { err: String(err) },
        'StdioSession: proxy backend failed to start, falling back to local mode',
      );
      initialBackend = this.buildLocalBackend();
      await initialBackend.start();
    }
    this.router.setInitialBackend(initialBackend);
    this.desiredMode = initialBackend.kind;

    // Subscribe to stable daemon state changes.
    this.watcher.onStableChange((nowActive) => {
      void this.onDaemonStateChange(nowActive);
    });

    // Install idle timer (non-lethal).
    this.resetIdleTimer();

    // Release the early-init stdout guard now that the MCP transport owns
    // the stream. Anything that writes to stdout from this point on is
    // expected to be a JSON-RPC frame.
    disarmStdoutGuard();
    await this.stdio.start();
    // Drift probe: warn (stderr-only) if installed version diverges from
    // the version that last ran `trace-mcp init`. Best-effort; no-op when
    // dev build (PKG_VERSION_INJECTED unset) or when no stamp file exists.
    if (PKG_VERSION !== '0.0.0-dev') {
      const drift = checkVersionDrift(PKG_VERSION);
      if (drift.drift) {
        try {
          process.stderr.write(versionDriftMessage(drift));
        } catch {
          /* best-effort */
        }
      }
    }
    this.handshake = createHandshakeWatchdog({
      timeoutMs: resolveHandshakeTimeout(
        this.opts.handshakeTimeoutMs,
        process.env.TRACE_MCP_HANDSHAKE_TIMEOUT,
      ),
      write: (line) => {
        // stderr only — stdout would itself corrupt the JSON-RPC stream
        try {
          process.stderr.write(line);
        } catch {
          /* best-effort */
        }
      },
    });
    logger.info(
      {
        mode: this.desiredMode,
        projectRoot: this.opts.projectRoot,
        idleTimeoutMs: this.opts.idleTimeoutMs,
        daemonStabilityMs: this.opts.daemonStabilityMs,
      },
      'StdioSession bootstrapped',
    );

    // Now that the client can be answered, try to bring a daemon up. Success
    // is picked up by the watcher, which swaps this session onto a proxy
    // backend; failure just leaves us in local mode.
    if (!daemonActive && this.opts.autoSpawnDaemon !== false) {
      void this.backgroundAutoSpawn();
    }
  }

  /**
   * Spawn a daemon off the critical path. A daemon that is starting up or
   * busy indexing can take minutes to answer /health — awaiting that before
   * `stdio.start()` used to leave `initialize` unanswered past the client's
   * MCP startup timeout, so the whole server came up as `failed` (TRA-704).
   */
  private async backgroundAutoSpawn(): Promise<void> {
    const spawnTimeoutMs = this.opts.autoSpawnTimeoutMs ?? 5_000;
    logger.info(
      { port: this.opts.daemonPort, timeoutMs: spawnTimeoutMs },
      'StdioSession: attempting daemon auto-spawn in background',
    );
    try {
      const result = await tryAutoSpawnDaemon(this.opts.daemonPort, spawnTimeoutMs);
      if (result.ok) {
        logger.info(
          { alreadyRunning: result.alreadyRunning },
          'StdioSession: daemon is reachable after auto-spawn',
        );
      } else {
        logger.warn(
          { error: result.error },
          'StdioSession: daemon auto-spawn failed, staying in local mode',
        );
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'StdioSession: daemon auto-spawn threw');
    }
  }

  /**
   * Graceful shutdown. Stops watcher, disposes active backend, clears timers,
   * waits for any in-flight background disposals (e.g. indexing) to settle.
   */
  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info({ reason }, 'StdioSession: shutting down');

    this.watcher.stop();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.handshake?.cancel();
    this.handshake = null;
    this.clearInitializeWatchdog();

    const active = this.router.getActiveBackend();
    await this.router.shutdown();
    if (active?.backgroundDispose) this.pendingBackgroundDisposes.add(active.backgroundDispose);

    // Give background cleanups a reasonable chance, but don't hang forever.
    if (this.pendingBackgroundDisposes.size > 0) {
      const all = Promise.allSettled([...this.pendingBackgroundDisposes]);
      await Promise.race([
        all,
        new Promise<void>((resolve) => {
          const t = setTimeout(() => resolve(), 5_000);
          t.unref?.();
        }),
      ]);
    }

    try {
      await this.stdio.close();
    } catch {
      /* best-effort */
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * A reachable /health is not proof that the daemon's MCP handler can answer.
   * Give the proxy a bounded window to complete the handshake; if it misses,
   * serve the session in-process and replay the frame there, so the client
   * gets a real `initialize` result instead of a hung connection (TRA-704).
   */
  private armInitializeWatchdog(id: string | number): void {
    this.clearInitializeWatchdog();
    if (this.router.getActiveKind() !== 'proxy') return;
    this.initializeId = id;
    this.initializeTimer = setTimeout(() => {
      void this.fallbackToLocal(id, 'proxy-initialize-timeout');
    }, PROXY_INITIALIZE_TIMEOUT_MS);
    this.initializeTimer.unref?.();
  }

  private clearInitializeWatchdog(): void {
    if (this.initializeTimer) clearTimeout(this.initializeTimer);
    this.initializeTimer = null;
    this.initializeId = null;
  }

  /**
   * Take the handshake away from a daemon that could not complete it — it
   * either timed out or answered with an error — and finish it in-process by
   * replaying the cached frame through a local backend.
   */
  private async fallbackToLocal(id: string | number, reason: string): Promise<void> {
    this.clearInitializeWatchdog();
    if (this.shuttingDown || this.router.getActiveKind() !== 'proxy') return;
    logger.warn(
      { id, reason, timeoutMs: PROXY_INITIALIZE_TIMEOUT_MS },
      'StdioSession: daemon did not complete initialize — serving this session in local mode',
    );
    this.proxyDisabled = true;
    // Drop the in-flight id so the swap does not answer it with a synthetic
    // error; the replay below is the response the client actually receives.
    this.router.forgetPending(id);
    await this.swapTo(this.buildLocalBackend(), reason);
    if (this.router.getActiveKind() !== 'local' || !this.cachedInitialize) return;
    await this.router.ingestFromClient(this.cachedInitialize);
  }

  private async onDaemonStateChange(nowActive: boolean): Promise<void> {
    if (this.shuttingDown) return;
    if (nowActive && this.proxyDisabled) return;
    const currentKind = this.router.getActiveKind();
    if (nowActive) {
      if (currentKind === 'proxy') return; // already proxying
      await this.swapTo(this.buildProxyBackend(), 'daemon-appeared');
    } else {
      if (currentKind === 'local') return; // already local
      await this.swapTo(this.buildLocalBackend(), 'daemon-disappeared');
    }
  }

  private async swapTo(next: Backend, reason: string): Promise<void> {
    logger.info({ reason, to: next.kind }, 'StdioSession: swapping backend');
    const prev = this.router.getActiveBackend();
    try {
      await this.router.swap(next);
      this.desiredMode = next.kind;
    } catch (err) {
      logger.error({ err: String(err) }, 'StdioSession: swap failed');
      // Try to still stop the new backend to avoid leaks.
      try {
        await next.stop();
      } catch {
        /* best-effort */
      }
      return;
    }
    if (prev?.backgroundDispose) {
      this.pendingBackgroundDisposes.add(prev.backgroundDispose);
      prev.backgroundDispose.finally(() =>
        this.pendingBackgroundDisposes.delete(prev.backgroundDispose!),
      );
    }
  }

  private resetIdleTimer(): void {
    if (this.opts.idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.onIdle();
    }, this.opts.idleTimeoutMs);
    this.idleTimer.unref?.();
    // If we were dormant (idle already released), wake up by reinstating the right backend.
    if (this.desiredMode === 'dormant' && !this.shuttingDown) {
      void this.wakeUp();
    }
  }

  private async onIdle(): Promise<void> {
    if (this.shuttingDown) return;
    const activeKind = this.router.getActiveKind();
    if (activeKind !== 'local') {
      // Proxy is already lightweight; nothing to release. Just keep the timer armed.
      this.resetIdleTimer();
      return;
    }
    logger.info('StdioSession: idle — releasing local backend resources');
    const prev = this.router.getActiveBackend();
    await this.router.shutdown(); // stops old backend, leaves no active backend
    if (prev?.backgroundDispose) {
      this.pendingBackgroundDisposes.add(prev.backgroundDispose);
      prev.backgroundDispose.finally(() =>
        this.pendingBackgroundDisposes.delete(prev.backgroundDispose!),
      );
    }
    this.desiredMode = 'dormant';
    // Note: router now has no active backend. ingestFromClient() will queue
    // messages until wakeUp() re-establishes one.
  }

  private wakeUp(): Promise<void> {
    if (this.wakePromise) return this.wakePromise;
    if (this.desiredMode !== 'dormant' || this.shuttingDown) return Promise.resolve();
    this.wakePromise = (async () => {
      try {
        logger.info('StdioSession: wake up from idle');
        const daemonActive = this.watcher.getCurrentState() && !this.proxyDisabled;
        const next = daemonActive ? this.buildProxyBackend() : this.buildLocalBackend();
        await next.start();
        this.desiredMode = next.kind;
        this.router.setInitialBackend(next);
        await this.router.flushPending();
      } finally {
        this.wakePromise = null;
      }
    })();
    return this.wakePromise;
  }

  /** Tools this session escalated into via `load_tools` (TRA-402). */
  private readonly loadedTools = new Set<string>();
  /** Preset/include/exclude filter, before any `load_tools` escalation. */
  private baseFilter: ((name: string) => boolean) | null = null;

  private baseToolFilter(name: string): boolean {
    this.baseFilter ??= createToolFilter(this.opts.config);
    return this.baseFilter(name);
  }

  private buildProxyBackend(): ProxyBackend {
    const daemonUrl = this.opts.daemonUrl ?? `http://127.0.0.1:${this.opts.daemonPort}`;
    return new ProxyBackend({
      daemonUrl,
      projectRoot: this.opts.projectRoot,
      clientId: this.clientId,
      clientTransportKind: 'stdio-proxy',
      // Seed the cached handshake so a swap-in backend (the client already
      // initialized through a previous backend) can re-establish a daemon
      // session on its first request instead of surfacing "Session expired".
      // Null at bootstrap — the initial backend captures it via send() instead.
      initializeFrame: this.cachedInitialize ?? undefined,
      // The preset is a property of *this* client session, not of the daemon
      // (which serves every tool to everyone) — so it has to be applied here
      // on the way out, or it never reaches a daemon-backed client (TRA-250).
      toolFilter: (name) => this.baseToolFilter(name) || this.loadedTools.has(name),
      // TRA-402: `load_tools` is answered by the proxy, not the daemon — the
      // daemon serves one full surface to every session and has no idea which
      // tools *this* session has paid for. Escalation state lives on the
      // Session so it survives a backend swap after a daemon restart.
      toolSurface: {
        isExcluded: (name) => (this.opts.config.tools?.exclude ?? []).includes(name),
        load: (names) => {
          for (const name of names) this.loadedTools.add(name);
        },
      },
    });
  }

  private buildLocalBackend(): LocalBackend {
    return new LocalBackend({
      projectRoot: this.opts.projectRoot,
      indexRoot: this.opts.indexRoot,
      config: this.opts.config,
      sharedDbPath: this.opts.sharedDbPath,
    });
  }
}
