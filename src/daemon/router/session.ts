import { randomUUID } from 'node:crypto';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { logger } from '../../logger.js';
import type { TraceMcpConfig } from '../../config.js';
import { MessageRouter } from './message-router.js';
import { ProxyBackend } from './proxy-backend.js';
import { LocalBackend } from './local-backend.js';
import { PollingDaemonWatcher } from './daemon-watcher.js';
import { tryAutoSpawnDaemon } from '../lifecycle.js';
import type { Backend } from './types.js';

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
  private readonly pendingBackgroundDisposes = new Set<Promise<void>>();
  private shuttingDown = false;
  private bootstrapped = false;
  /** Tracks the mode we *intend* to have — may differ briefly from router.getActiveKind() during swap. */
  private desiredMode: 'proxy' | 'local' | 'dormant' = 'dormant';
  /** Guards against concurrent wakeUp() calls when multiple stdin messages arrive in the dormant window. */
  private wakePromise: Promise<void> | null = null;

  constructor(opts: StdioSessionOptions) {
    this.opts = opts;
    this.stdio = new StdioServerTransport();
    this.router = new MessageRouter({
      sendToClient: (msg) => this.stdio.send(msg),
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
      this.resetIdleTimer();
      void this.router.ingestFromClient(msg as JSONRPCMessage);
    };
    this.stdio.onerror = (err) => {
      logger.warn({ err: String(err) }, 'StdioSession: stdio transport error');
    };

    await this.watcher.start();
    let daemonActive = this.watcher.getCurrentState();

    // Auto-spawn: if no daemon is up and we're allowed to spawn one, try it.
    // This avoids N concurrent local-mode indexings in a multi-root workspace
    // where N stdio sessions would otherwise each build their own DB.
    if (!daemonActive && this.opts.autoSpawnDaemon !== false) {
      const spawnTimeoutMs = this.opts.autoSpawnTimeoutMs ?? 5_000;
      logger.info(
        { port: this.opts.daemonPort, timeoutMs: spawnTimeoutMs },
        'StdioSession: attempting daemon auto-spawn',
      );
      const result = await tryAutoSpawnDaemon(this.opts.daemonPort, spawnTimeoutMs);
      if (result.ok) {
        daemonActive = true;
        logger.info(
          { alreadyRunning: result.alreadyRunning },
          'StdioSession: daemon is reachable after auto-spawn',
        );
      } else {
        logger.warn(
          { error: result.error },
          'StdioSession: daemon auto-spawn failed, falling back to local mode',
        );
      }
    }

    const initialBackend = daemonActive ? this.buildProxyBackend() : this.buildLocalBackend();
    await initialBackend.start();
    this.router.setInitialBackend(initialBackend);
    this.desiredMode = initialBackend.kind;

    // Subscribe to stable daemon state changes.
    this.watcher.onStableChange((nowActive) => {
      void this.onDaemonStateChange(nowActive);
    });

    // Install idle timer (non-lethal).
    this.resetIdleTimer();

    await this.stdio.start();
    logger.info(
      {
        mode: this.desiredMode,
        projectRoot: this.opts.projectRoot,
        idleTimeoutMs: this.opts.idleTimeoutMs,
        daemonStabilityMs: this.opts.daemonStabilityMs,
      },
      'StdioSession bootstrapped',
    );
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

  private async onDaemonStateChange(nowActive: boolean): Promise<void> {
    if (this.shuttingDown) return;
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
        const daemonActive = this.watcher.getCurrentState();
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

  private buildProxyBackend(): ProxyBackend {
    const daemonUrl = this.opts.daemonUrl ?? `http://127.0.0.1:${this.opts.daemonPort}`;
    return new ProxyBackend({
      daemonUrl,
      projectRoot: this.opts.projectRoot,
      clientId: this.clientId,
      clientTransportKind: 'stdio-proxy',
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
