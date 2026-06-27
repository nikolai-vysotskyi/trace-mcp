import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProxyBackend, type ProxyTransport } from '../../src/daemon/router/proxy-backend.js';

/**
 * Fake StreamableHTTP transport. Records sent frames, can auto-echo the
 * initialize response (like the daemon), and can be flipped to reject every
 * send with the daemon's "Session not found" error (simulating a restart).
 */
class FakeTransport implements ProxyTransport {
  onmessage?: (msg: JSONRPCMessage) => void;
  onerror?: (err: Error) => void;
  sent: JSONRPCMessage[] = [];
  started = false;
  closed = false;
  failSessionLost = false;
  // Body the daemon returns for a dead session. Defaults to the 404 restart
  // case; overridable to the "Session expired, reinitialize required" variant.
  sessionLostMessage = 'Session not found';

  async start(): Promise<void> {
    this.started = true;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async send(msg: JSONRPCMessage): Promise<void> {
    if (this.failSessionLost) {
      throw new Error(
        'Streamable HTTP error: Error POSTing to endpoint: ' +
          `{"jsonrpc":"2.0","error":{"code":-32000,"message":"${this.sessionLostMessage}"},"id":null}`,
      );
    }
    this.sent.push(msg);
    const m = msg as Record<string, unknown>;
    if (m.method === 'initialize') {
      // Daemon answers initialize asynchronously, like the real transport.
      queueMicrotask(() =>
        this.onmessage?.({ jsonrpc: '2.0', id: m.id, result: { ok: true } } as JSONRPCMessage),
      );
    }
  }
}

function initFrame(id: number): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } },
  } as unknown as JSONRPCMessage;
}
function toolCall(id: number): JSONRPCMessage {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: {} } as unknown as JSONRPCMessage;
}
function methodOf(msg: JSONRPCMessage): unknown {
  return (msg as Record<string, unknown>).method;
}

describe('ProxyBackend daemon-restart recovery', () => {
  let transports: FakeTransport[];
  let clientInbox: JSONRPCMessage[];
  // When true, every transport opened from now on (including recovery ones)
  // reports a lost session — simulates a daemon stuck in a restart loop.
  let failNewTransports: boolean;

  function makeBackend(): ProxyBackend {
    const backend = new ProxyBackend({
      daemonUrl: 'http://127.0.0.1:65535',
      projectRoot: '/tmp/does-not-resolve-to-any-registered-project',
      clientId: 'test-client',
      transportFactory: () => {
        const t = new FakeTransport();
        t.failSessionLost = failNewTransports;
        transports.push(t);
        return t;
      },
    });
    backend.onmessage = (m) => clientInbox.push(m);
    return backend;
  }

  beforeEach(() => {
    transports = [];
    clientInbox = [];
    failNewTransports = false;
    // Project/client registration is best-effort fetch — stub it out.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('transparently re-initializes and retries after the daemon session is lost', async () => {
    const backend = makeBackend();
    await backend.start();
    await backend.send(initFrame(1));
    await backend.send(toolCall(2)); // works on the first transport

    const first = transports[0]!;
    expect(first.sent.map(methodOf)).toEqual(['initialize', 'tools/call']);

    // Daemon restarts: the held session is now stale.
    first.failSessionLost = true;

    await backend.send(toolCall(3));

    // A fresh transport was opened and the handshake replayed before the retry.
    expect(transports).toHaveLength(2);
    const second = transports[1]!;
    expect(second.sent.map(methodOf)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect((second.sent[2] as { id: number }).id).toBe(3);
    // Old transport was closed during recovery.
    expect(first.closed).toBe(true);

    // The client saw exactly one initialize response (from the original
    // handshake) — the replayed initialize echo must be swallowed.
    const initResponses = clientInbox.filter((m) => (m as { id?: number }).id === 1);
    expect(initResponses).toHaveLength(1);
  });

  it('recovers from the daemon\'s "Session expired, reinitialize required" (-32000)', async () => {
    const backend = makeBackend();
    await backend.start();
    await backend.send(initFrame(1));
    await backend.send(toolCall(2));

    // The daemon kept the session id but lost its in-memory state → it answers
    // 404 -32000 "Session expired, reinitialize required" (cli.ts /mcp handler),
    // a different string from the "Session not found" restart case.
    const first = transports[0]!;
    first.failSessionLost = true;
    first.sessionLostMessage = 'Session expired, reinitialize required';

    await backend.send(toolCall(3));

    expect(transports).toHaveLength(2);
    const second = transports[1]!;
    expect(second.sent.map(methodOf)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect((second.sent[2] as { id: number }).id).toBe(3);
  });

  it('retries reinit a bounded number of times, then gives up so the watcher can fall back', async () => {
    const backend = makeBackend();
    await backend.start();
    await backend.send(initFrame(1));
    await backend.send(toolCall(2));

    // Daemon is stuck restarting: the held session AND every freshly-opened one
    // report a lost session.
    transports[0]!.failSessionLost = true;
    failNewTransports = true;

    await expect(backend.send(toolCall(3))).rejects.toThrow(/session/i);

    // Original transport + exactly one fresh transport per bounded attempt (2).
    expect(transports).toHaveLength(3);
  });

  it('does not attempt recovery when no initialize was ever cached', async () => {
    const backend = makeBackend();
    await backend.start();
    transports[0]!.failSessionLost = true;

    await expect(backend.send(toolCall(1))).rejects.toThrow(/session not found/i);
    expect(transports).toHaveLength(1); // no fresh transport opened
  });

  it('seeded initialize frame (swap-in) recovers without a prior send() handshake', async () => {
    // Simulates a local→proxy swap-back: the client already completed its
    // handshake through a previous backend, so this fresh backend never sees
    // `initialize` via send(). Seeded with the frame, its first real request
    // must still re-establish the session instead of surfacing "Session
    // expired" — the bug exposed once read-only local made swap-back fire (#209).
    const backend = new ProxyBackend({
      daemonUrl: 'http://127.0.0.1:65535',
      projectRoot: '/tmp/does-not-resolve-to-any-registered-project',
      clientId: 'test-client',
      initializeFrame: initFrame(1),
      transportFactory: () => {
        const t = new FakeTransport();
        t.failSessionLost = failNewTransports;
        transports.push(t);
        return t;
      },
    });
    backend.onmessage = (m) => clientInbox.push(m);
    await backend.start();

    // The daemon has no session for us — we never initialized through send().
    transports[0]!.failSessionLost = true;
    transports[0]!.sessionLostMessage = 'Session expired, reinitialize required';

    await backend.send(toolCall(5));

    // Recovery fired off the seeded frame: fresh transport, handshake replayed,
    // original request retried.
    expect(transports).toHaveLength(2);
    expect(transports[1]!.sent.map(methodOf)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect((transports[1]!.sent[2] as { id: number }).id).toBe(5);
  });

  it('propagates non-session errors without re-initializing', async () => {
    const backend = makeBackend();
    await backend.start();
    await backend.send(initFrame(1));

    const first = transports[0]!;
    first.send = async () => {
      throw new Error('ECONNRESET socket hang up');
    };

    await expect(backend.send(toolCall(2))).rejects.toThrow(/ECONNRESET/);
    expect(transports).toHaveLength(1);
  });
});
