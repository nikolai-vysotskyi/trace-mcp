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
          '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Session not found"},"id":null}',
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

  function makeBackend(): ProxyBackend {
    const backend = new ProxyBackend({
      daemonUrl: 'http://127.0.0.1:65535',
      projectRoot: '/tmp/does-not-resolve-to-any-registered-project',
      clientId: 'test-client',
      transportFactory: () => {
        const t = new FakeTransport();
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

  it('does not attempt recovery when no initialize was ever cached', async () => {
    const backend = makeBackend();
    await backend.start();
    transports[0]!.failSessionLost = true;

    await expect(backend.send(toolCall(1))).rejects.toThrow(/session not found/i);
    expect(transports).toHaveLength(1); // no fresh transport opened
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
