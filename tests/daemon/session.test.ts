import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MessageRouter } from '../../src/daemon/router/message-router.js';
import type { Backend } from '../../src/daemon/router/types.js';

/**
 * StdioSession has heavy real-world dependencies (StdioServerTransport,
 * LocalBackend with full indexer, ProxyBackend with HTTP client). We test
 * the core router contract the Session relies on — promote, demote, idle,
 * and background-dispose tracking — using fake backends.
 *
 * Deeper end-to-end coverage (Session + real backends) lives in the manual
 * verification steps documented in the plan and is better suited to an
 * integration test harness.
 */

class FakeBackend implements Backend {
  readonly kind: 'proxy' | 'local';
  onmessage?: (msg: JSONRPCMessage) => void;
  onerror?: (err: Error) => void;
  backgroundDispose?: Promise<void>;
  sent: JSONRPCMessage[] = [];
  started = false;
  stopped = false;
  /** Resolves after fake background cleanup "finishes". */
  backgroundResolver?: () => void;

  constructor(kind: 'proxy' | 'local' = 'proxy') { this.kind = kind; }
  async start(): Promise<void> { this.started = true; }
  async stop(): Promise<void> {
    this.stopped = true;
    this.backgroundDispose = new Promise<void>((r) => { this.backgroundResolver = r; });
  }
  async send(msg: JSONRPCMessage): Promise<void> { this.sent.push(msg); }
  emitResponse(msg: JSONRPCMessage): void { this.onmessage?.(msg); }
  finishBackgroundDispose(): void { this.backgroundResolver?.(); }
}

function req(id: number): JSONRPCMessage {
  return { jsonrpc: '2.0', id, method: 'ping', params: {} } as unknown as JSONRPCMessage;
}
function resp(id: number): JSONRPCMessage {
  return { jsonrpc: '2.0', id, result: {} } as unknown as JSONRPCMessage;
}

describe('router promote/demote flow (session-level contract)', () => {
  let inbox: JSONRPCMessage[];
  let router: MessageRouter;

  beforeEach(() => {
    inbox = [];
    router = new MessageRouter({ sendToClient: (m) => { inbox.push(m); }, drainTimeoutMs: 50 });
  });

  it('promote: proxy → local on daemon disappear, client sees no gap', async () => {
    const proxy = new FakeBackend('proxy');
    await proxy.start();
    router.setInitialBackend(proxy);
    // Simulate client traffic that completes cleanly.
    await router.ingestFromClient(req(1));
    proxy.emitResponse(resp(1));

    // Daemon disappears — promote to local.
    const local = new FakeBackend('local');
    await router.swap(local);
    expect(router.getActiveKind()).toBe('local');
    expect(proxy.stopped).toBe(true);

    // New request goes to local backend.
    await router.ingestFromClient(req(2));
    expect(local.sent.map((m) => (m as { id: number }).id)).toEqual([2]);
  });

  it('demote: local → proxy on daemon appear; local background dispose still tracked', async () => {
    const local = new FakeBackend('local');
    await local.start();
    router.setInitialBackend(local);
    await router.ingestFromClient(req(1));
    local.emitResponse(resp(1));

    const proxy = new FakeBackend('proxy');
    await router.swap(proxy);
    expect(router.getActiveKind()).toBe('proxy');
    // Local's background dispose should exist (stop() set it).
    expect(local.backgroundDispose).toBeDefined();

    // Simulate background cleanup finishing later — Session would await this on shutdown.
    local.finishBackgroundDispose();
    await expect(local.backgroundDispose!).resolves.toBeUndefined();
  });

  it('idle sequence: shutdown → wake-up flushes queued traffic to new backend', async () => {
    const local = new FakeBackend('local');
    await local.start();
    router.setInitialBackend(local);
    await router.ingestFromClient(req(1));
    local.emitResponse(resp(1));

    // Simulate Session.onIdle() — releases local.
    await router.shutdown();
    expect(router.getActiveBackend()).toBeNull();

    // Client sends a tool call while dormant — router queues it.
    await router.ingestFromClient(req(2));

    // Wake-up: Session picks a backend (daemon or local) and re-arms router.
    const wakeLocal = new FakeBackend('local');
    await wakeLocal.start();
    router.setInitialBackend(wakeLocal);
    await router.flushPending();

    expect(wakeLocal.sent.map((m) => (m as { id: number }).id)).toEqual([2]);
  });

  it('rapid flap: two swaps in sequence end in the latest mode', async () => {
    const a = new FakeBackend('proxy');
    await a.start();
    router.setInitialBackend(a);
    await router.ingestFromClient(req(1));
    a.emitResponse(resp(1));

    const b = new FakeBackend('local');
    await router.swap(b);
    const c = new FakeBackend('proxy');
    await router.swap(c);

    expect(router.getActiveKind()).toBe('proxy');
    expect(router.getActiveBackend()).toBe(c);
    expect(a.stopped).toBe(true);
    expect(b.stopped).toBe(true);
    expect(c.started).toBe(true);
  });

  it('drain timeout synthesizes error for pending request across swap', async () => {
    const a = new FakeBackend('proxy');
    await a.start();
    router.setInitialBackend(a);

    await router.ingestFromClient(req(99));  // pending, no response
    const b = new FakeBackend('local');
    await router.swap(b, { drainTimeoutMs: 10 });

    const synthErr = inbox.find((m) => (m as { id?: number }).id === 99);
    expect(synthErr).toBeDefined();
    expect((synthErr as { error?: { code: number } }).error?.code).toBe(-32603);
  });
});
