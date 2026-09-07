import http from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * TRA-1148: the local-mode fallback must not be able to swallow `initialize`.
 *
 * The thin proxy entry (TRA-970) deliberately never loads LocalBackend — it
 * reaches it through `await import('./local-backend.js')`, a genuine first
 * load off disk, and only when the daemon has already let the session down.
 * A package swap (`npm i -g trace-mcp`, or the desktop app replacing its
 * bundle) is exactly the event that kills the daemon AND removes that chunk
 * at the same moment, so the fallback fails precisely in the scenario it was
 * built for. Disk full and a native-module load failure land in the same spot.
 *
 * `fallbackToLocal` claimed the client's `initialize` id via `forgetPending`
 * *before* that fallible build, and is invoked fire-and-forget (`void`). So
 * the throw orphaned the handshake: nobody answered id 1, the process safety
 * net swallowed the rejection, and the client sat until its own timeout and
 * reported `Failed to connect` — the hung handshake TRA-704 exists to prevent.
 */
vi.mock('../../src/daemon/lifecycle.js', () => ({
  tryAutoSpawnDaemon: () => new Promise(() => {}),
}));

/** Stands in for a chunk that is not on disk right now (mid-swap). */
vi.mock('../../src/daemon/router/local-backend.js', () => ({
  get LocalBackend(): never {
    throw new Error(
      "Cannot find module '/opt/homebrew/lib/node_modules/trace-mcp/dist/local-backend.js'",
    );
  },
}));

const { TraceMcpConfigSchema } = await import('../../src/config.js');
const { StdioSession } = await import('../../src/daemon/router/session.js');

/** /health is fine, /mcp answers the handshake with an error — forces fallbackToLocal. */
async function startSplitHealthServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url?.startsWith('/mcp')) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('daemon is not well');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, status: 'healthy' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function responsesFor(frames: unknown[], id: number): unknown[] {
  return frames.filter((f) => {
    const m = f as Record<string, unknown>;
    return m.id === id && (Object.hasOwn(m, 'result') || Object.hasOwn(m, 'error'));
  });
}

describe('StdioSession local fallback failure (TRA-1148)', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
  });

  it('answers initialize even when the local backend cannot be built', async () => {
    const daemon = await startSplitHealthServer();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const session = new StdioSession({
      projectRoot: process.cwd(),
      indexRoot: process.cwd(),
      config: TraceMcpConfigSchema.parse({}),
      sharedDbPath: '/nonexistent/shared.db',
      daemonPort: daemon.port,
      idleTimeoutMs: 0,
      daemonStabilityMs: 60_000,
      autoSpawnDaemon: false,
      autoSpawnTimeoutMs: 20_000,
      handshakeTimeoutMs: 0,
      stdin,
      stdout,
    });
    cleanup = async () => {
      await session.shutdown('test');
      await daemon.close();
    };

    const frames: unknown[] = [];
    stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) frames.push(JSON.parse(line));
      }
    });

    await session.bootstrap();
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);

    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1_500);
      t.unref?.();
    });

    // A failed fallback may not silently eat the handshake. One answer, and an
    // error the client can surface beats a connection that never resolves.
    expect(responsesFor(frames, 1)).toHaveLength(1);
  });
});
