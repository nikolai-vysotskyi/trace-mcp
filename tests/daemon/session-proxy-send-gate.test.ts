import http from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Slow-vs-dead discrimination on the proxy send path (TRA-1997).
 *
 * Night QA showed `proxy-send-failed` as a flat ~5/min shelf with the daemon
 * healthy all along: every transient send failure (bulk-index event-loop
 * stalls, TRA-1828) permanently promoted a thin proxy session to a full
 * local backend. The rescue path (TRA-1080) was built for a *dead* daemon —
 * a merely starved one must not trigger it.
 *
 * `rescueFailedProxySend` now probes /health (the same slow-vs-dead signal
 * the handshake path uses) before promoting: a reachable daemon records
 * `proxy-send-transient` with attribution and stays proxy — only that one
 * request fails — while a silent daemon keeps the old promote-to-local
 * rescue with the same attribution attached.
 */

const { recorded } = vi.hoisted(() => ({
  recorded: [] as Array<{ reason: string; details?: unknown }>,
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('../../src/daemon/lifecycle.js', () => ({
  tryAutoSpawnDaemon: () => new Promise(() => {}),
}));

vi.mock('../../src/daemon/router/fallback-stats.js', () => ({
  recordSessionFallback: (reason: string, _file?: string, details?: unknown) => {
    recorded.push({ reason, details });
  },
}));

vi.mock('../../src/daemon/router/local-backend.js', () => ({
  LocalBackend: class FakeLocalBackend {
    readonly kind = 'local' as const;
    onmessage?: (msg: unknown) => void;
    onerror?: (err: Error) => void;
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async send(msg: unknown): Promise<void> {
      const id = (msg as { id?: string | number }).id;
      this.onmessage?.({ jsonrpc: '2.0', id, result: { servedBy: 'fake-local' } });
    }
  },
}));

const { TraceMcpConfigSchema } = await import('../../src/config.js');
const { StdioSession } = await import('../../src/daemon/router/session.js');

/** Fake daemon: /health answers, /mcp POSTs die mid-flight (starved loop). */
async function startStarvedDaemon(): Promise<{
  port: number;
  killMcp: () => void;
  close: () => Promise<void>;
}> {
  let mcpAlive = true;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/health' || req.url?.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url?.startsWith('/mcp')) {
      if (req.method === 'GET') {
        // No SSE stream — the SDK treats 405 as "POST-only, fine".
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('no sse');
        return;
      }
      if (!mcpAlive) {
        res.destroy();
        return;
      }
      // Starved event loop: accept the socket, never answer.
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    killMcp: () => {
      mcpAlive = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function makeSession(port: number, stdin: PassThrough, stdout: PassThrough) {
  return new StdioSession({
    projectRoot: process.cwd(),
    indexRoot: process.cwd(),
    config: TraceMcpConfigSchema.parse({}),
    sharedDbPath: '/nonexistent/shared.db',
    daemonPort: port,
    idleTimeoutMs: 0,
    daemonStabilityMs: 60_000,
    autoSpawnDaemon: false,
    autoSpawnTimeoutMs: 20_000,
    handshakeTimeoutMs: 0,
    stdin,
    stdout,
  });
}

async function waitFor(
  frames: unknown[],
  pred: (f: unknown) => boolean,
  timeoutMs = 15_000,
): Promise<unknown> {
  const start = Date.now();
  for (;;) {
    const hit = frames.find(pred);
    if (hit !== undefined) return hit;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for frame');
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}

const isAnswer = (id: number) => (f: unknown) => {
  const m = f as Record<string, unknown>;
  return m.id === id && (Object.hasOwn(m, 'result') || Object.hasOwn(m, 'error'));
};

describe('rescueFailedProxySend slow-vs-dead gate (TRA-1997)', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    recorded.length = 0;
    await cleanup?.();
    cleanup = null;
  });

  it('stays proxy when /health answers: transient is recorded with attribution, one request fails', async () => {
    const daemon = await startStarvedDaemon();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const session = makeSession(daemon.port, stdin, stdout);
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
    // Hangs on the daemon side: withRetry burns its 3 attempts, then the
    // rescue probes /health (alive) and stays proxy. Fail the POST fast so
    // the test does not wait out the daemon's never-answer.
    daemon.killMcp();
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} })}\n`);

    const answer = (await waitFor(frames, isAnswer(7))) as Record<string, unknown>;
    expect(answer).toHaveProperty('error');
    expect((answer.error as { code: number }).code).toBe(-32603);

    // No promotion: only the transient marker, with which frame failed and why.
    expect(recorded.map((r) => r.reason)).toEqual(['proxy-send-transient']);
    const details = recorded[0].details as Record<string, unknown>;
    expect(details.tool).toBe('tools/list');
    expect(details.reqId).toBe(7);
    expect(String(details.err ?? '')).not.toHaveLength(0);
  }, 30_000);

  it('promotes to local when the daemon is silent, replaying through the new backend', async () => {
    const daemon = await startStarvedDaemon();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const session = makeSession(daemon.port, stdin, stdout);
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
    // Dead daemon: every socket dies AND /health is gone.
    await daemon.close();
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} })}\n`);

    // The frame is replayed through the local backend, not failed.
    const answer = (await waitFor(frames, isAnswer(9))) as Record<string, unknown>;
    expect(answer).toHaveProperty('result');

    expect(recorded.map((r) => r.reason)).toEqual(['proxy-send-failed']);
    const details = recorded[0].details as Record<string, unknown>;
    expect(details.tool).toBe('tools/list');
    expect(details.reqId).toBe(9);
    expect(String(details.err ?? '')).not.toHaveLength(0);
  }, 30_000);
});
