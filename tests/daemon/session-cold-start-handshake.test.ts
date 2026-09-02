import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * TRA-704: the daemon is an optimization and must never gate protocol
 * liveness. Auto-spawn used to be awaited *before* `stdio.start()`, so a
 * daemon that was starting up or busy indexing left `initialize` unanswered
 * for tens of seconds and the MCP client marked the server `failed`.
 *
 * Here the daemon socket accepts connections and then answers nothing, and
 * `tryAutoSpawnDaemon` never settles — the handshake must still complete.
 */

/** Never settles — stands in for a daemon that is spawning/indexing. */
const autoSpawnCalled = vi.fn();
vi.mock('../../src/daemon/lifecycle.js', () => ({
  tryAutoSpawnDaemon: (...args: unknown[]) => {
    autoSpawnCalled(...args);
    return new Promise(() => {});
  },
}));

/** Stands in for the real indexer-backed local backend. */
vi.mock('../../src/daemon/router/local-backend.js', () => ({
  LocalBackend: class {
    readonly kind = 'local' as const;
    onmessage?: (msg: JSONRPCMessage) => void;
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async send(msg: JSONRPCMessage): Promise<void> {
      const id = (msg as { id?: string | number }).id;
      if (id === undefined) return;
      this.onmessage?.({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'x' } },
      } as unknown as JSONRPCMessage);
    }
  },
}));

const { TraceMcpConfigSchema } = await import('../../src/config.js');
const { StdioSession } = await import('../../src/daemon/router/session.js');

/** A socket that accepts and never replies — worst case for a /health probe. */
async function startBlackHoleServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    // Accept, then say nothing at all.
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // Probes leave their sockets hanging by design — drop them explicitly
        // or close() would wait for them forever.
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * A daemon whose cheap routes answer instantly while /mcp accepts and never
 * responds — a wedged MCP handler behind a working /health.
 */
async function startSplitHealthServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const held = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/mcp')) {
      held.add(res); // accepted, answered never
      return;
    }
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'healthy' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of held) res.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('StdioSession cold start (TRA-704)', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
    vi.clearAllMocks();
  });

  /**
   * Drives a real `StdioServerTransport` over in-memory streams against the
   * given daemon port and returns the first frame the client sees, or throws
   * if nothing arrives inside the acceptance bound.
   */
  async function handshakeAgainst(daemonPort: number): Promise<{ frame: string; ms: number }> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const session = new StdioSession({
      projectRoot: process.cwd(),
      indexRoot: process.cwd(),
      config: TraceMcpConfigSchema.parse({}),
      sharedDbPath: '/nonexistent/shared.db',
      daemonPort,
      idleTimeoutMs: 0,
      daemonStabilityMs: 60_000,
      autoSpawnDaemon: true,
      autoSpawnTimeoutMs: 20_000,
      handshakeTimeoutMs: 0,
      stdin,
      stdout,
    });
    const previous = cleanup;
    cleanup = async () => {
      await session.shutdown('test');
      await previous?.();
    };

    const firstFrame = new Promise<string>((resolve) => {
      stdout.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });

    const started = Date.now();
    await session.bootstrap();
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);

    const frame = await Promise.race([
      firstFrame,
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('no initialize response within 2s')), 2_000);
        t.unref?.();
      }),
    ]);
    return { frame, ms: Date.now() - started };
  }

  it('answers initialize while the daemon is unreachable and auto-spawn is still pending', async () => {
    const blackHole = await startBlackHoleServer();
    cleanup = () => blackHole.close();

    const { frame, ms } = await handshakeAgainst(blackHole.port);

    expect(JSON.parse(frame)).toMatchObject({ id: 1, result: { protocolVersion: '2024-11-05' } });
    expect(ms).toBeLessThan(2_000);
    // The spawn attempt still happens — just off the critical path.
    expect(autoSpawnCalled).toHaveBeenCalledWith(blackHole.port, 20_000);
  });

  it('answers initialize when /health is healthy but the daemon MCP handler is wedged', async () => {
    const splitHealth = await startSplitHealthServer();
    cleanup = () => splitHealth.close();

    // /health answers, so bootstrap picks proxy mode — and the daemon then
    // never answers the handshake it accepted.
    const { frame, ms } = await handshakeAgainst(splitHealth.port);

    expect(JSON.parse(frame)).toMatchObject({ id: 1, result: { protocolVersion: '2024-11-05' } });
    expect(ms).toBeLessThan(2_000);
  });
});
