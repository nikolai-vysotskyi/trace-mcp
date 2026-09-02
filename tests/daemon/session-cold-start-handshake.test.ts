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

describe('StdioSession cold start (TRA-704)', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
    vi.clearAllMocks();
  });

  it('answers initialize while the daemon is unreachable and auto-spawn is still pending', async () => {
    const blackHole = await startBlackHoleServer();
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const session = new StdioSession({
      projectRoot: process.cwd(),
      indexRoot: process.cwd(),
      config: TraceMcpConfigSchema.parse({}),
      sharedDbPath: '/nonexistent/shared.db',
      daemonPort: blackHole.port,
      idleTimeoutMs: 0,
      daemonStabilityMs: 60_000,
      autoSpawnDaemon: true,
      autoSpawnTimeoutMs: 20_000,
      handshakeTimeoutMs: 0,
      stdin,
      stdout,
    });
    cleanup = async () => {
      await session.shutdown('test');
      await blackHole.close();
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

    expect(JSON.parse(frame)).toMatchObject({ id: 1, result: { protocolVersion: '2024-11-05' } });
    expect(Date.now() - started).toBeLessThan(2_000);
    // The spawn attempt still happens — just off the critical path.
    expect(autoSpawnCalled).toHaveBeenCalledWith(blackHole.port, 20_000);
  });
});
