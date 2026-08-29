import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../logger.js';
import { resolveWorktreeAware, worktreeHint } from '../../registry-worktree.js';
import { resolveDeepestKnownRoot } from '../../subproject/resolve.js';
import { isTransientError, withRetry } from '../../utils/retry.js';
import { LOAD_TOOLS_HINT, expandLoadRequest, planToolLoad } from '../../server/tool-surface.js';
import type { Backend } from './types.js';

/**
 * Minimal transport surface ProxyBackend depends on. The real implementation
 * is the SDK's StreamableHTTPClientTransport; tests inject a fake.
 */
export interface ProxyTransport {
  onmessage?: (msg: JSONRPCMessage) => void;
  onerror?: (err: Error) => void;
  start(): Promise<void>;
  send(msg: JSONRPCMessage): Promise<void>;
  close(): Promise<void>;
}

export interface ProxyBackendOptions {
  daemonUrl: string; // e.g. "http://127.0.0.1:3741"
  projectRoot: string; // absolute path used to scope /mcp
  clientId: string; // stable uuid for this stdio session (for /api/clients)
  clientTransportKind?: string; // "stdio-proxy" by default
  /**
   * The client's `initialize` frame, when this backend is created by a *swap*
   * (e.g. local→proxy after the daemon recovers) rather than at bootstrap.
   * On a swap the client already completed its handshake through a previous
   * backend and will NOT re-send `initialize` through us — so without this seed
   * `initializeFrame` stays null, the first real request POSTs session-less, the
   * daemon answers "Session expired, reinitialize required", and send()'s
   * recovery is skipped (it bails on a null frame). Seeding it lets that
   * recovery replay the handshake and mint a session on the first request (#209).
   */
  initializeFrame?: JSONRPCMessage;
  /**
   * Per-session tool-surface filter (preset / tools.include / tools.exclude).
   * The daemon serves every tool to every session — it has to, since one daemon
   * backs many sessions with different presets — so the preset can only be
   * honoured here, at the session boundary: `tools/list` results are filtered
   * and `tools/call` for a filtered-out tool is rejected without forwarding
   * (TRA-250). Omit to forward the daemon's full surface unchanged.
   */
  toolFilter?: (name: string) => boolean;
  /**
   * Progressive tool disclosure on the daemon path (TRA-402). `load_tools` has
   * to be answered here rather than forwarded: the daemon serves one full
   * surface to every session and has no idea which tools *this* session has
   * paid for. Given this hook, the proxy resolves the request against the
   * daemon's advertised tool list, widens `toolFilter` through `load`, replies
   * itself, and pushes `notifications/tools/list_changed` at the client.
   * Omit to forward `load_tools` like any other call.
   */
  toolSurface?: {
    /** Hard-excluded by `tools.exclude`; escalation must not undo that. */
    isExcluded: (name: string) => boolean;
    /** Widen this session's surface to include `names`. */
    load: (names: string[]) => void;
  };
  /**
   * Test seam: build a transport for the resolved /mcp URL + project root.
   * Defaults to a real StreamableHTTPClientTransport.
   */
  transportFactory?: (mcpUrl: string, projectRoot: string) => ProxyTransport;
}

/** Max wall-clock to wait for the daemon's initialize reply during recovery. */
const REINIT_TIMEOUT_MS = 10_000;

/**
 * How many reinitialize+retry attempts to make on a lost session before giving
 * up and letting the error propagate (so the watcher can fall back to local
 * mode). Greater than 1 because the daemon can restart *again* in the narrow
 * reinit→retry window — a single attempt would surface that second loss to the
 * client as the very "session expired" disconnect this recovery exists to hide.
 */
const MAX_REINIT_ATTEMPTS = 2;

/** The daemon's /mcp session router rejects stale/missing sessions with these. */
function isSessionLostError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase();
  if (
    msg.includes('session not found') ||
    msg.includes('session expired') ||
    msg.includes('reinitialize required')
  ) {
    return true;
  }
  // StreamableHTTPError carries the HTTP status code; the daemon answers a
  // dead session with 404.
  return (err as { code?: unknown })?.code === 404;
}

function isInitializeRequest(
  msg: JSONRPCMessage,
): msg is JSONRPCMessage & { id: string | number; method: 'initialize' } {
  const m = msg as Record<string, unknown>;
  return m.method === 'initialize' && m.id !== undefined && m.id !== null;
}

function messageId(msg: JSONRPCMessage): string | number | undefined {
  const id = (msg as Record<string, unknown>).id;
  return id === undefined || id === null ? undefined : (id as string | number);
}

/** JSON-RPC "method not found" — what an MCP client gets for an unknown tool. */
const METHOD_NOT_FOUND = -32601;

/** Name of the tool a `tools/call` frame targets, if it is one. */
function toolCallName(msg: JSONRPCMessage): string | undefined {
  const m = msg as Record<string, unknown>;
  if (m.method !== 'tools/call') return undefined;
  const name = (m.params as Record<string, unknown> | undefined)?.name;
  return typeof name === 'string' ? name : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Forwards MCP messages between the MessageRouter and a running daemon's /mcp endpoint.
 *
 * Does NOT own health-checking — that's the DaemonWatcher's job at the Session level.
 *
 * Daemon-restart resilience: the daemon is stateful (sessionId → transport).
 * When it restarts (idle shutdown + respawn, crash, or auto-update) the session
 * this proxy holds becomes stale and every request comes back as
 * `404 Session not found`. The daemon expects clients to recover by re-running
 * `initialize` (see the /mcp handler in cli.ts), but the upstream MCP client
 * (Claude Desktop) only initializes once and never sees the 404. So this proxy
 * performs that recovery itself: it caches the client's `initialize` frame and,
 * on a session-lost send, transparently opens a fresh transport, replays the
 * handshake, and retries — so the client never sees a disconnect.
 */
export class ProxyBackend implements Backend {
  readonly kind = 'proxy' as const;

  onmessage?: (msg: JSONRPCMessage) => void;
  onerror?: (err: Error) => void;

  private readonly opts: ProxyBackendOptions;
  private httpTransport: ProxyTransport | null = null;
  private started = false;
  private stopping = false;

  /** Resolved once in start(); reused when re-establishing a dead session. */
  private projectRoot: string | null = null;
  /** The client's initialize frame, cached so we can replay it after a daemon restart. */
  private initializeFrame: (JSONRPCMessage & { id: string | number }) | null = null;
  /** Single-flight guard so concurrent failed sends share one recovery. */
  private reestablishing: Promise<void> | null = null;
  /** While re-initializing, swallow the replayed initialize response by id. */
  private pendingReinitId: string | number | null = null;
  private resolveReinit: (() => void) | null = null;
  /** Ids of in-flight `tools/list` requests, whose responses need filtering. */
  private readonly pendingToolsListIds = new Set<string | number>();
  /**
   * The daemon's last *unfiltered* `tools/list` result — the only place the
   * proxy learns which tools exist beyond this session's preset, and the source
   * of the schemas `load_tools` echoes back (TRA-402).
   */
  private daemonTools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];

  constructor(opts: ProxyBackendOptions) {
    this.opts = opts;
    // Swap-in seed: adopt the client's initialize frame so send()'s recovery
    // can establish a daemon session on the first request (see options doc).
    if (opts.initializeFrame && isInitializeRequest(opts.initializeFrame)) {
      this.initializeFrame = opts.initializeFrame;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.projectRoot = this.resolveProjectRoot();
    await this.registerWithDaemon(this.projectRoot);
    const transport = this.buildTransport(this.projectRoot);
    this.wire(transport);
    await transport.start();
    this.httpTransport = transport;
    this.started = true;
    logger.info({ mcpUrl: this.mcpUrl(this.projectRoot) }, 'ProxyBackend started');
  }

  async stop(): Promise<void> {
    if (this.stopping || !this.started) return;
    this.stopping = true;
    const { daemonUrl, clientId } = this.opts;
    // Best-effort client unregister (don't block on this).
    fetch(`${daemonUrl}/api/clients?id=${clientId}`, { method: 'DELETE' }).catch(() => {});
    try {
      await this.httpTransport?.close();
    } catch (err) {
      logger.debug({ err: String(err) }, 'ProxyBackend: close error (ignored)');
    }
    this.httpTransport = null;
    this.started = false;
    logger.info('ProxyBackend stopped');
  }

  async send(msg: JSONRPCMessage): Promise<void> {
    if (!this.httpTransport) throw new Error('ProxyBackend not started');
    // Cache the handshake so we can replay it if the daemon session dies.
    if (isInitializeRequest(msg)) this.initializeFrame = msg;
    if (this.opts.toolFilter) {
      const id = messageId(msg);
      const called = toolCallName(msg);
      if (called === 'load_tools' && this.opts.toolSurface && id !== undefined) {
        this.handleLoadTools(msg, id);
        return;
      }
      // A filtered-out tool must be genuinely uncallable, not merely hidden
      // from tools/list — answer it here instead of forwarding (TRA-250).
      if (called !== undefined && !this.opts.toolFilter(called)) {
        if (id !== undefined) {
          this.onmessage?.({
            jsonrpc: '2.0',
            id,
            error: {
              code: METHOD_NOT_FOUND,
              message: `Tool "${called}" is not available in this session's tool preset.`,
            },
          } as unknown as JSONRPCMessage);
        }
        return;
      }
      if ((msg as Record<string, unknown>).method === 'tools/list' && id !== undefined) {
        this.pendingToolsListIds.add(id);
      }
    }
    try {
      // Transient network blips (daemon mid-restart, dropped connection) are
      // common during a daemon respawn; retry a couple of times with short
      // backoff before falling through to the heavier session-lost recovery
      // or surfacing an error to the client (#TRA-6).
      await withRetry(() => this.httpTransport!.send(msg), {
        maxAttempts: 3,
        initialDelayMs: 200,
        maxDelayMs: 800,
        label: 'ProxyBackend.send',
        isRetryable: isTransientError,
      });
      return;
    } catch (err) {
      // Only recover from a lost daemon session, and never for the initialize
      // frame itself (a failing initialize is a real connection problem the
      // watcher should handle by swapping to local mode).
      if (!isSessionLostError(err) || !this.initializeFrame || isInitializeRequest(msg)) {
        throw err;
      }
      // Reinitialize and retry, bounded. If recovery itself fails with a
      // non-session error (the daemon is genuinely down) we propagate at once
      // so the watcher can fall back to local mode; only a *repeated* session
      // loss (the daemon restarted again mid-recovery) is worth another pass.
      let lastErr: unknown = err;
      for (let attempt = 1; attempt <= MAX_REINIT_ATTEMPTS; attempt++) {
        logger.warn(
          { err: String(lastErr), attempt },
          'ProxyBackend: daemon session lost — reinitializing and retrying',
        );
        try {
          await this.reestablishSession();
          await this.httpTransport!.send(msg);
          return;
        } catch (retryErr) {
          lastErr = retryErr;
          if (!isSessionLostError(retryErr)) throw retryErr;
        }
      }
      throw lastErr;
    }
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Open a fresh transport, replay the cached initialize so the daemon mints a
   * new session, complete the handshake, then swap the live transport. The
   * replayed initialize's response is swallowed (the client already has one).
   */
  private reestablishSession(): Promise<void> {
    if (this.reestablishing) return this.reestablishing;
    this.reestablishing = (async () => {
      const projectRoot = this.projectRoot ?? this.resolveProjectRoot();
      this.projectRoot = projectRoot;
      // Re-register in case the respawned daemon lost its in-memory state.
      await this.registerWithDaemon(projectRoot);

      const next = this.buildTransport(projectRoot);
      this.wire(next);
      await next.start();

      const initId = messageId(this.initializeFrame!)!;
      const done = new Promise<void>((resolve) => {
        this.resolveReinit = resolve;
      });
      this.pendingReinitId = initId;
      try {
        await next.send(this.initializeFrame!);
        await Promise.race([done, delay(REINIT_TIMEOUT_MS)]);
      } finally {
        this.pendingReinitId = null;
        this.resolveReinit = null;
      }

      // Complete the MCP handshake — the daemon won't serve requests until the
      // `initialized` notification lands.
      await next.send({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      } as unknown as JSONRPCMessage);

      const dead = this.httpTransport;
      this.httpTransport = next;
      try {
        await dead?.close();
      } catch {
        /* the old transport is already broken */
      }
      logger.info('ProxyBackend: session reestablished after daemon restart');
    })().finally(() => {
      this.reestablishing = null;
    });
    return this.reestablishing;
  }

  /**
   * Answer a `load_tools` call locally instead of forwarding it (TRA-402).
   *
   * Resolves the request against the daemon's advertised surface, widens this
   * session's filter, replies with the same payload shape the in-process tool
   * produces, and emits `tools/list_changed` so a client that honours the
   * notification re-reads the now-larger surface. A client that ignores it
   * still gets the loaded tools' schemas in the reply and can drive them
   * through `batch`.
   */
  private handleLoadTools(msg: JSONRPCMessage, id: string | number): void {
    const surface = this.opts.toolSurface!;
    const filter = this.opts.toolFilter!;
    const args = ((msg as Record<string, unknown>).params as Record<string, unknown> | undefined)
      ?.arguments as { preset?: string; tools?: string[] } | undefined;
    const reply = (result: unknown): void => {
      this.onmessage?.({ jsonrpc: '2.0', id, result } as unknown as JSONRPCMessage);
    };

    const deferred = this.daemonTools.filter((t) => !filter(t.name));
    const deferredNames = deferred.map((t) => t.name);
    const known = new Set(this.daemonTools.map((t) => t.name));

    // No arguments is the discovery call (mirrors the in-process tool).
    if (!args?.preset && !(args?.tools && args.tools.length > 0)) {
      reply({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              loaded: [],
              deferred_tools: deferredNames,
              hint: 'Names only — the schemas are what this session is not paying for. Call load_tools again with `tools` or `preset` to pull any of them in.',
            }),
          },
        ],
      });
      return;
    }

    const plan = planToolLoad(
      expandLoadRequest({ preset: args.preset, tools: args.tools }, deferredNames),
      {
        isLoaded: (n) => known.has(n) && filter(n),
        isDeferred: (n) => known.has(n),
        isExcluded: surface.isExcluded,
      },
    );

    if (plan.load.length > 0) {
      surface.load(plan.load);
      // Push the spec notification at the client. Fire-and-forget by design:
      // there is nothing useful to do if the client's transport rejects it,
      // and the reply below already carries the schemas as a fallback.
      this.onmessage?.({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      } as unknown as JSONRPCMessage);
    }

    const byName = new Map(this.daemonTools.map((t) => [t.name, t]));
    reply({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            loaded: plan.load,
            already_loaded: plan.alreadyLoaded,
            unknown: plan.unknown,
            blocked: plan.blocked,
            tools: plan.load.map((n) => ({
              name: n,
              description: byName.get(n)?.description,
              input_schema: byName.get(n)?.inputSchema,
            })),
            still_deferred: deferredNames.length - plan.load.length,
            hint: plan.load.length > 0 ? LOAD_TOOLS_HINT : undefined,
          }),
        },
      ],
    });
  }

  /**
   * Narrow a daemon `tools/list` reply to this session's preset. The daemon
   * always answers with its full surface — filtering it out here is what makes
   * the preset actually reach the client on the daemon path (TRA-250).
   */
  private filterToolsListResponse(msg: JSONRPCMessage): JSONRPCMessage {
    const filter = this.opts.toolFilter;
    const id = messageId(msg);
    if (!filter || id === undefined || !this.pendingToolsListIds.delete(id)) return msg;
    const result = (msg as Record<string, unknown>).result as
      | { tools?: Array<{ name?: unknown }> }
      | undefined;
    if (!Array.isArray(result?.tools)) return msg;
    this.daemonTools = result.tools as Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>;
    const tools = result.tools.filter((t) => typeof t?.name !== 'string' || filter(t.name));
    if (tools.length === result.tools.length) return msg;
    logger.debug(
      { total: result.tools.length, kept: tools.length },
      'ProxyBackend: filtered tools/list to session preset',
    );
    return { ...msg, result: { ...result, tools } } as JSONRPCMessage;
  }

  private wire(transport: ProxyTransport): void {
    transport.onmessage = (msg) => {
      // Swallow the replayed initialize response — the client already received
      // one during its original handshake; a duplicate would corrupt its state.
      if (this.pendingReinitId !== null && messageId(msg) === this.pendingReinitId) {
        this.resolveReinit?.();
        return;
      }
      this.onmessage?.(this.filterToolsListResponse(msg));
    };
    transport.onerror = (err) => {
      logger.warn({ err: String(err) }, 'ProxyBackend: HTTP transport error');
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    };
  }

  private buildTransport(projectRoot: string): ProxyTransport {
    if (this.opts.transportFactory) {
      return this.opts.transportFactory(this.mcpUrl(projectRoot), projectRoot);
    }
    // Send X-Trace-Project as belt-and-braces: if any intermediary strips the
    // `?project=` query string, the daemon still has a hint to route this
    // session to the correct project before the multi-project guard.
    return new StreamableHTTPClientTransport(new URL(this.mcpUrl(projectRoot)), {
      requestInit: {
        headers: { 'X-Trace-Project': projectRoot },
      },
    }) as unknown as ProxyTransport;
  }

  private mcpUrl(projectRoot: string): string {
    return `${this.opts.daemonUrl}/mcp?project=${encodeURIComponent(projectRoot)}`;
  }

  /**
   * Resolve the project root this session should bind to: a registered ancestor
   * (nested package in a monorepo) or the canonical repo behind a git worktree.
   */
  private resolveProjectRoot(): string {
    // Prefer the deepest KNOWN root: a registered subproject (e.g.
    // the/fair/fair-front) beats its container ancestor (the) so the session
    // binds to the subproject's own scoped index instead of the container's
    // mixed blob (#209 — "ругается на зонтик").
    const known = resolveDeepestKnownRoot(this.opts.projectRoot);
    if (known && known !== this.opts.projectRoot) {
      logger.info(
        { requested: this.opts.projectRoot, resolved: known },
        'ProxyBackend: routing to deepest known project/subproject',
      );
      return known;
    }
    if (known) return known;

    // Worktree-aware fallback: if path-only resolution didn't land on a
    // registered project, check whether this path is a *linked* git worktree
    // of an already-indexed canonical repo. Common when AI agents spawn from
    // `git worktree add` feature branches.
    const wt = resolveWorktreeAware(this.opts.projectRoot);
    if (wt.canonicalCandidates.length > 0) {
      const canonical = wt.canonicalCandidates[0].entry;
      logger.info(
        {
          requested: this.opts.projectRoot,
          canonical: canonical.root,
          rationale: wt.canonicalCandidates[0].rationale,
          hint: worktreeHint(wt),
        },
        'ProxyBackend: routing worktree to canonical indexed repo',
      );
      return canonical.root;
    }
    return this.opts.projectRoot;
  }

  /** Best-effort project + client registration with the daemon. Never throws. */
  private async registerWithDaemon(projectRoot: string): Promise<void> {
    const { daemonUrl, clientId } = this.opts;
    // Project registration (daemon returns 409 if already registered).
    await fetch(`${daemonUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: projectRoot }),
    }).catch(() => {
      /* daemon may already know */
    });
    // Client registration for the menu bar UI.
    fetch(`${daemonUrl}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: clientId,
        project: projectRoot,
        transport: this.opts.clientTransportKind ?? 'stdio-proxy',
      }),
    }).catch(() => {
      /* non-fatal */
    });
  }
}
