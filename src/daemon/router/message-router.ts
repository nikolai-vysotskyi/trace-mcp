import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../../logger.js';
import type { Backend } from './types.js';

export interface MessageRouterOptions {
  /** Called to send messages to the MCP client (stdout). */
  sendToClient: (msg: JSONRPCMessage) => Promise<void> | void;
  /** Max time to wait for pending responses during swap (ms). */
  drainTimeoutMs?: number;
  /**
   * Last chance to rescue a client request whose send to the active backend
   * threw (TRA-1080). Return `true` when the frame has been re-issued through
   * another backend and will be answered there; the router then leaves the id
   * alone. Return `false` (or throw) and the router answers it with the
   * synthetic error it always did.
   *
   * Called only for requests — a failed notification has no id to answer and
   * nothing to replay.
   */
  onSendFailure?: (msg: JSONRPCMessage, err: unknown) => Promise<boolean>;
}

type ClientMessage = JSONRPCMessage;

function isRequest(
  msg: JSONRPCMessage,
): msg is JSONRPCMessage & { id: string | number; method: string } {
  return (
    typeof (msg as Record<string, unknown>).method === 'string' &&
    (msg as Record<string, unknown>).id !== undefined &&
    (msg as Record<string, unknown>).id !== null
  );
}

function isResponse(msg: JSONRPCMessage): msg is JSONRPCMessage & { id: string | number } {
  const m = msg as Record<string, unknown>;
  return (
    m.id !== undefined &&
    m.id !== null &&
    (Object.hasOwn(m, 'result') || Object.hasOwn(m, 'error')) &&
    m.method === undefined
  );
}

/**
 * Central message router sitting between a singleton StdioServerTransport and
 * a swappable Backend (proxy or local).
 *
 * Life cycle:
 *   - router.setInitialBackend(b): attaches b as the initial active backend.
 *     Call once after construction; does NOT drain anything.
 *   - router.ingestFromClient(msg): called for every stdin→us message.
 *   - router.swap(newBackend): drain then swap. While transitioning, stdin
 *     messages are queued and flushed after swap.
 */
export class MessageRouter {
  private readonly sendToClient: (msg: JSONRPCMessage) => Promise<void> | void;
  private readonly drainTimeoutMs: number;
  private readonly onSendFailure?: (msg: JSONRPCMessage, err: unknown) => Promise<boolean>;

  private activeBackend: Backend | null = null;
  private transitioning = false;
  private readonly pendingRequestIds = new Set<string | number>();
  private readonly waiters = new Set<() => void>();
  private readonly queue: ClientMessage[] = [];

  constructor(opts: MessageRouterOptions) {
    this.sendToClient = opts.sendToClient;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 5_000;
    this.onSendFailure = opts.onSendFailure;
  }

  /** Returns the current active backend (or null if between backends). */
  getActiveBackend(): Backend | null {
    return this.activeBackend;
  }

  getActiveKind(): Backend['kind'] | null {
    return this.activeBackend?.kind ?? null;
  }

  /**
   * Attach the initial backend. Wires its onmessage to forward to the client.
   * Does NOT call start() on the backend — caller is expected to start() first
   * so any errors surface before the router is running.
   */
  setInitialBackend(b: Backend): void {
    if (this.activeBackend) throw new Error('Router already has an active backend; use swap()');
    this.wireBackend(b);
    this.activeBackend = b;
  }

  /**
   * Forward a message from the client (stdin) to the active backend.
   * While transitioning, the message is queued and flushed after swap.
   */
  async ingestFromClient(msg: ClientMessage): Promise<void> {
    if (this.transitioning) {
      this.queue.push(msg);
      return;
    }
    if (!this.activeBackend) {
      // No backend at all — queue until one shows up.
      this.queue.push(msg);
      return;
    }
    if (isRequest(msg)) {
      this.pendingRequestIds.add(msg.id);
    }
    try {
      await this.activeBackend.send(msg);
    } catch (err) {
      logger.error({ err: String(err) }, 'MessageRouter: backend send failed');
      // Synthesize error response so the client doesn't hang — but only if the
      // id is still ours to answer. A backend stopped mid-send rejects here
      // after the caller has already claimed the id via forgetPending() to
      // re-issue it elsewhere; answering anyway would give the client two
      // responses for one id.
      if (isRequest(msg) && this.pendingRequestIds.has(msg.id)) {
        // Offer the owner a rescue before answering with an error. The handler
        // is expected to `forgetPending` the id itself before it swaps, so the
        // swap's drain does not answer the frame it is about to replay — which
        // is why `clearPending` below is a no-op on the handled path and still
        // correct on the unhandled one.
        if (this.onSendFailure) {
          let handled = false;
          try {
            handled = await this.onSendFailure(msg, err);
          } catch (rescueErr) {
            logger.warn({ err: String(rescueErr) }, 'MessageRouter: send-failure rescue threw');
          }
          if (handled) return;
        }
        await this.failPendingRequest(msg.id, -32603, `Backend send failed: ${String(err)}`);
      }
    }
  }

  /**
   * Drain-then-swap. Stops accepting new client messages (queues them),
   * waits up to drainTimeoutMs for pending responses, synthesizes errors
   * for any that remain, then disposes the old backend and starts the new one.
   *
   * Returns when the new backend is active and the queue has been flushed to it.
   */
  async swap(newBackend: Backend, opts?: { drainTimeoutMs?: number }): Promise<void> {
    if (this.transitioning) {
      throw new Error('MessageRouter already transitioning');
    }
    const drainMs = opts?.drainTimeoutMs ?? this.drainTimeoutMs;
    this.transitioning = true;
    const old = this.activeBackend;
    const prevKind = old?.kind ?? 'null';
    logger.info(
      { from: prevKind, to: newBackend.kind, drainMs, pending: this.pendingRequestIds.size },
      'MessageRouter: swap begin',
    );

    try {
      // 1. Wait for pending requests to drain (up to drainMs).
      await this.waitForDrain(drainMs);

      // 2. Detach old backend's onmessage so late responses don't race or leak to stdout.
      if (old) old.onmessage = undefined;

      // 3. Synthesize error responses for anything still pending.
      if (this.pendingRequestIds.size > 0) {
        const stuck = [...this.pendingRequestIds];
        logger.warn(
          { count: stuck.length },
          'MessageRouter: drain timeout, synthesizing errors for pending',
        );
        for (const id of stuck) {
          await this.failPendingRequest(id, -32603, 'Request interrupted by backend switch');
        }
      }

      // 4. Stop old backend (non-blocking heavy cleanup runs in backgroundDispose).
      if (old) {
        try {
          await old.stop();
        } catch (err) {
          logger.warn({ err: String(err) }, 'MessageRouter: old backend stop errored');
        }
      }

      // 5. Start new backend and make it active.
      this.wireBackend(newBackend);
      await newBackend.start();
      this.activeBackend = newBackend;

      // 6. Flush any queued client messages through the new backend.
      const toFlush = this.queue.splice(0, this.queue.length);
      for (const m of toFlush) {
        if (isRequest(m)) this.pendingRequestIds.add(m.id);
        try {
          await newBackend.send(m);
        } catch (err) {
          logger.error({ err: String(err) }, 'MessageRouter: flush send failed');
          if (isRequest(m) && this.pendingRequestIds.has(m.id)) {
            await this.failPendingRequest(m.id, -32603, `Backend send failed: ${String(err)}`);
          }
        }
      }
      logger.info(
        { from: prevKind, to: newBackend.kind, flushed: toFlush.length },
        'MessageRouter: swap complete',
      );
    } finally {
      this.transitioning = false;
    }
  }

  /**
   * Flush any messages that were queued while there was no active backend
   * (e.g. right after wakeUp). Must be called after setInitialBackend().
   * Does NOT rewire the backend — just drains the internal queue.
   */
  async flushPending(): Promise<void> {
    if (!this.activeBackend) return;
    const backend = this.activeBackend;
    const toFlush = this.queue.splice(0, this.queue.length);
    for (const m of toFlush) {
      if (isRequest(m)) this.pendingRequestIds.add(m.id);
      try {
        await backend.send(m);
      } catch (err) {
        logger.error({ err: String(err) }, 'MessageRouter: flushPending send failed');
        if (isRequest(m) && this.pendingRequestIds.has(m.id)) {
          await this.failPendingRequest(m.id, -32603, `Backend send failed: ${String(err)}`);
        }
      }
    }
  }

  /**
   * Drop a pending request id without answering it. For a caller that intends
   * to re-issue the same frame through another backend: without this, the next
   * swap would synthesize an error response for it and the client would end up
   * with two responses for one id.
   */
  forgetPending(id: string | number): void {
    this.clearPending(id);
  }

  /**
   * Stop the current backend. Idempotent.
   * Does NOT clear the message queue — anything still buffered stays until a
   * new backend is attached (via setInitialBackend + flushPending) or until
   * the router is garbage collected. This matches the idle/wake flow.
   *
   * Drains pending requests before stopping the backend so that in-flight
   * tools/list / initialize round-trips complete instead of being cancelled
   * with AbortError when the HTTP transport closes (mirrors swap()).
   */
  async shutdown(opts?: { drainTimeoutMs?: number }): Promise<void> {
    const drainMs = opts?.drainTimeoutMs ?? this.drainTimeoutMs;
    const old = this.activeBackend;
    if (old) {
      // Wait for in-flight requests to settle while the backend is still wired.
      if (this.pendingRequestIds.size > 0) {
        await this.waitForDrain(drainMs);
      }
      old.onmessage = undefined;
      try {
        await old.stop();
      } catch {
        /* best-effort */
      }
    }
    this.activeBackend = null;
    // Fail fast any requests we can't possibly answer now; queue stays intact.
    if (this.pendingRequestIds.size > 0) {
      for (const id of [...this.pendingRequestIds]) {
        await this.failPendingRequest(id, -32603, 'Server idle — request cancelled');
      }
    }
    this.waiters.clear();
    this.transitioning = false;
  }

  // ── Internals ───────────────────────────────────────────────────────

  private wireBackend(b: Backend): void {
    b.onmessage = (msg) => {
      // Track response → clear pending id.
      if (isResponse(msg)) {
        // A response is only valid if it matches an in-flight request we are
        // still waiting to answer. If the id was already cleared (synthetic
        // error on send failure, drain timeout, shutdown) or forgotten (rescued
        // for replay), forwarding it would give the client two responses for
        // one request id (TRA-1148, TRA-1149).
        if (!this.pendingRequestIds.has(msg.id)) {
          logger.warn(
            { id: msg.id, kind: b.kind },
            'MessageRouter: dropping late or duplicate response for non-pending id',
          );
          return;
        }
        this.clearPending(msg.id);
      }
      // Forward to stdout — fire-and-forget; errors logged.
      try {
        const ret = this.sendToClient(msg);
        if (ret && typeof (ret as Promise<unknown>).then === 'function') {
          (ret as Promise<unknown>).catch((err) => {
            logger.warn({ err: String(err) }, 'MessageRouter: sendToClient errored');
          });
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'MessageRouter: sendToClient threw');
      }
    };
    b.onerror = (err) => {
      logger.warn({ err: String(err), kind: b.kind }, 'MessageRouter: backend error');
    };
  }

  private clearPending(id: string | number): void {
    if (this.pendingRequestIds.delete(id)) {
      if (this.pendingRequestIds.size === 0) {
        for (const w of this.waiters) w();
        this.waiters.clear();
      }
    }
  }

  private waitForDrain(timeoutMs: number): Promise<void> {
    if (this.pendingRequestIds.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        this.waiters.delete(done);
        resolve();
      };
      this.waiters.add(done);
      const t = setTimeout(done, timeoutMs);
      t.unref?.();
    });
  }

  /**
   * Synthesize and send an error response for a pending request, dropping it
   * from pendingRequestIds so subsequent late responses from any backend are
   * dropped rather than double-answering the client (TRA-1149).
   */
  private async failPendingRequest(
    id: string | number,
    code: number,
    message: string,
  ): Promise<void> {
    this.clearPending(id);
    await this.sendErrorResponseSafely(id, code, message);
  }

  private async sendErrorResponseSafely(
    id: string | number,
    code: number,
    message: string,
  ): Promise<void> {
    try {
      const resp = { jsonrpc: '2.0', id, error: { code, message } } as unknown as JSONRPCMessage;
      const ret = this.sendToClient(resp);
      if (ret && typeof (ret as Promise<unknown>).then === 'function') await ret;
    } catch (err) {
      logger.warn({ err: String(err) }, 'MessageRouter: failed to send synthetic error');
    }
  }
}
