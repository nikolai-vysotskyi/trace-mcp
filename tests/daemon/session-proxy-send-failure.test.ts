import http from 'node:http';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * TRA-1080: a daemon that dies mid-session must not take the client's tools
 * with it.
 *
 * `PollingDaemonWatcher` is the only thing that used to notice, and it is
 * deliberately slow: 10 s poll + 30 s stability. That delay is harmless in the
 * local → proxy direction (local mode keeps answering while we wait) and
 * fatal in the other one — every request in the window came back as
 * `-32603 Backend send failed: TypeError: fetch failed`. Reproduced against a
 * real daemon on a sandbox port: 45 s and eight failed calls before the swap
 * landed, which for an agent is indistinguishable from the server being gone.
 *
 * A failed send *is* the evidence the poller is still waiting for, so the
 * session now promotes on it and replays the frame locally — the same
 * forget-swap-replay the initialize watchdog has used since TRA-704.
 */

vi.mock('../../src/daemon/lifecycle.js', () => ({
  tryAutoSpawnDaemon: () => new Promise(() => {}),
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
        result: { servedBy: 'local' },
      } as unknown as JSONRPCMessage);
    }
  },
}));

const { TraceMcpConfigSchema } = await import('../../src/config.js');
const { StdioSession } = await import('../../src/daemon/router/session.js');

/** A daemon that answers /health and /mcp, until it is killed. */
async function startDaemon(): Promise<{ port: number; kill: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (!req.url?.startsWith('/mcp')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, status: 'healthy' }));
        return;
      }
      let id: unknown;
      try {
        id = JSON.parse(body).id;
      } catch {
        /* notification or garbage */
      }
      if (id === undefined || id === null) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'd' } },
        })}\n\n`,
      );
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    kill: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('StdioSession: daemon dies mid-session (TRA-1080)', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
    vi.clearAllMocks();
  });

  it('promotes to local on a failed proxy send instead of erroring the request', async () => {
    const daemon = await startDaemon();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const session = new StdioSession({
      projectRoot: process.cwd(),
      indexRoot: process.cwd(),
      config: TraceMcpConfigSchema.parse({}),
      sharedDbPath: '/nonexistent/shared.db',
      daemonPort: daemon.port,
      idleTimeoutMs: 0,
      // Far longer than the test: the watcher must not be what rescues this.
      daemonStabilityMs: 600_000,
      autoSpawnDaemon: false,
      handshakeTimeoutMs: 0,
      stdin,
      stdout,
    });
    cleanup = async () => {
      await session.shutdown('test');
      await daemon.kill();
    };

    const frames: unknown[] = [];
    stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) frames.push(JSON.parse(line));
      }
    });
    const responseFor = (id: number) =>
      frames.find((f) => {
        const m = f as Record<string, unknown>;
        return m.id === id && (Object.hasOwn(m, 'result') || Object.hasOwn(m, 'error'));
      }) as Record<string, unknown> | undefined;
    const waitFor = async (id: number, ms: number) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const r = responseFor(id);
        if (r) return r;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 25);
          t.unref?.();
        });
      }
      return undefined;
    };

    await session.bootstrap();
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    expect(await waitFor(1, 3_000)).toMatchObject({ id: 1, result: { serverInfo: { name: 'd' } } });

    // The break: the daemon is gone, and nothing has told the session yet.
    await daemon.kill();

    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const second = await waitFor(2, 10_000);
    expect(second).toMatchObject({ id: 2, result: { servedBy: 'local' } });
    expect(second?.error).toBeUndefined();
  }, 20_000);
});
