import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { MessageRouter } from '../../src/daemon/router/message-router.js';
import type { Backend } from '../../src/daemon/router/types.js';

/**
 * Fake backend that records sent messages and lets tests emit responses.
 */
class FakeBackend implements Backend {
  readonly kind: 'proxy' | 'local';
  onmessage?: (msg: JSONRPCMessage) => void;
  onerror?: (err: Error) => void;
  backgroundDispose?: Promise<void>;

  sent: JSONRPCMessage[] = [];
  started = false;
  stopped = false;
  sendImpl?: (msg: JSONRPCMessage) => Promise<void>;

  constructor(kind: 'proxy' | 'local' = 'proxy') { this.kind = kind; }
  async start(): Promise<void> { this.started = true; }
  async stop(): Promise<void> { this.stopped = true; }
  async send(msg: JSONRPCMessage): Promise<void> {
    this.sent.push(msg);
    if (this.sendImpl) await this.sendImpl(msg);
  }
  emitResponse(msg: JSONRPCMessage): void { this.onmessage?.(msg); }
}

function req(id: number, method = 'tools/call'): JSONRPCMessage {
  return { jsonrpc: '2.0', id, method, params: {} } as unknown as JSONRPCMessage;
}
function resp(id: number, result: unknown = { ok: true }): JSONRPCMessage {
  return { jsonrpc: '2.0', id, result } as unknown as JSONRPCMessage;
}

describe('MessageRouter', () => {
  let clientInbox: JSONRPCMessage[];
  let router: MessageRouter;

  beforeEach(() => {
    clientInbox = [];
    router = new MessageRouter({
      sendToClient: (msg) => { clientInbox.push(msg); },
      drainTimeoutMs: 50,
    });
  });

  it('forwards client messages to the active backend', async () => {
    const b = new FakeBackend();
    await b.start();
    router.setInitialBackend(b);

    await router.ingestFromClient(req(1));
    await router.ingestFromClient(req(2));

    expect(b.sent).toHaveLength(2);
    expect((b.sent[0] as { id: number }).id).toBe(1);
  });

  it('forwards backend messages to the client', async () => {
    const b = new FakeBackend();
    await b.start();
    router.setInitialBackend(b);

    b.emitResponse(resp(1));
    expect(clientInbox).toHaveLength(1);
    expect((clientInbox[0] as { id: number }).id).toBe(1);
  });

  it('queues messages arriving during a swap and flushes to the new backend', async () => {
    const a = new FakeBackend('proxy');
    const b = new FakeBackend('local');
    await a.start();
    router.setInitialBackend(a);

    // First request goes through a.
    await router.ingestFromClient(req(1));
    expect(a.sent).toHaveLength(1);

    // Respond to drain pending.
    a.emitResponse(resp(1));

    // Start a swap; during transition new messages should queue.
    const swapPromise = router.swap(b);
    await router.ingestFromClient(req(2));
    await swapPromise;

    expect(a.stopped).toBe(true);
    expect(b.started).toBe(true);
    expect(b.sent).toHaveLength(1);
    expect((b.sent[0] as { id: number }).id).toBe(2);
    expect(router.getActiveKind()).toBe('local');
  });

  it('waits for pending requests up to drainTimeoutMs then synthesizes error', async () => {
    const a = new FakeBackend('proxy');
    const b = new FakeBackend('local');
    await a.start();
    router.setInitialBackend(a);

    await router.ingestFromClient(req(42));
    expect(a.sent).toHaveLength(1);

    // Don't answer id=42 — force drain timeout.
    const start = Date.now();
    await router.swap(b, { drainTimeoutMs: 30 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(25);
    // Synthetic error response should be in client inbox.
    const synth = clientInbox.find((m) => (m as { id?: number }).id === 42);
    expect(synth).toBeDefined();
    expect((synth as { error?: { code: number } }).error?.code).toBe(-32603);
  });

  it('clears pending id on response from backend', async () => {
    const a = new FakeBackend();
    await a.start();
    router.setInitialBackend(a);

    await router.ingestFromClient(req(7));
    a.emitResponse(resp(7));

    // Now swap quickly — no pending, should not timeout.
    const b = new FakeBackend();
    const start = Date.now();
    await router.swap(b, { drainTimeoutMs: 500 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('buffers messages when there is no active backend, flushed by flushPending', async () => {
    const a = new FakeBackend();
    await a.start();
    router.setInitialBackend(a);
    await router.ingestFromClient(req(1));
    a.emitResponse(resp(1));
    await router.shutdown();

    // Router has no active backend — new messages should queue.
    await router.ingestFromClient(req(2));
    await router.ingestFromClient(req(3));

    const b = new FakeBackend('local');
    await b.start();
    router.setInitialBackend(b);
    await router.flushPending();

    expect(b.sent).toHaveLength(2);
  });

  it('does not leak backend.onmessage to stdout after swap', async () => {
    const a = new FakeBackend();
    const b = new FakeBackend();
    await a.start();
    router.setInitialBackend(a);

    const swapPromise = router.swap(b);
    await swapPromise;

    // Emit stale message from old backend — should be ignored (onmessage detached).
    const beforeCount = clientInbox.length;
    a.emitResponse(resp(99));
    expect(clientInbox.length).toBe(beforeCount);

    // New backend still works.
    b.emitResponse(resp(100));
    expect(clientInbox.find((m) => (m as { id?: number }).id === 100)).toBeDefined();
  });

  it('synthesizes error response when send() rejects', async () => {
    const a = new FakeBackend();
    a.sendImpl = async () => { throw new Error('boom'); };
    await a.start();
    router.setInitialBackend(a);

    await router.ingestFromClient(req(5));

    const err = clientInbox.find((m) => (m as { id?: number }).id === 5);
    expect(err).toBeDefined();
    expect((err as { error?: { code: number } }).error?.code).toBe(-32603);
  });

  it('shutdown clears pending and disposes the backend', async () => {
    const a = new FakeBackend();
    await a.start();
    router.setInitialBackend(a);
    await router.ingestFromClient(req(10));

    await router.shutdown();
    expect(a.stopped).toBe(true);
    expect(router.getActiveBackend()).toBeNull();
    // Pending should have a synthetic error.
    const err = clientInbox.find((m) => (m as { id?: number }).id === 10);
    expect(err).toBeDefined();
    expect((err as { error?: { code: number } }).error?.code).toBe(-32603);
  });
});
