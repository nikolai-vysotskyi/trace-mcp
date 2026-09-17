import http from 'node:http';
import { PassThrough } from 'node:stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Adaptive proxy-initialize timeout (TRA-1605, PROC-1).
 *
 * The old fixed 1 s watchdog fired at the same instant in every session on a
 * loaded box, stampeding N sessions into local mode at once. The watchdog is
 * now extended when /health proves the daemon is alive-but-slow or still
 * warming up — and only then:
 *
 * - healthy fast daemon → handshake completes inside the base budget
 *   (regression: the PROXY path is not slowed down);
 * - warming daemon (status "starting") that answers late → the session waits
 *   past the base budget instead of falling back (single-flight wait);
 * - warming daemon that never answers → the session still falls back, just
 *   after the bounded grace (no pinning).
 */

vi.mock('../../src/daemon/lifecycle.js', () => ({
  tryAutoSpawnDaemon: () => new Promise(() => {}),
}));

/** Stands in for the real indexer-backed local backend; counts landings. */
const localLandings: string[] = [];
vi.mock('../../src/daemon/router/local-backend.js', () => ({
  LocalBackend: class {
    readonly kind = 'local' as const;
    onmessage?: (msg: JSONRPCMessage) => void;
    async start(): Promise<void> {
      localLandings.push('start');
    }
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

type McpBehavior = { kind: 'answer'; afterMs: number } | { kind: 'hang' };

/**
 * Fake daemon with an independently controllable /health shape and /mcp
 * latency — the split a loaded box produces: cheap routes answer while the
 * MCP handler is starved.
 */
async function startFakeDaemon(opts: {
  health: Record<string, unknown>;
  mcp: McpBehavior;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const timers: NodeJS.Timeout[] = [];
  const held = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url?.startsWith('/health?')) {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(opts.health));
      return;
    }
    if (req.url?.startsWith('/mcp')) {
      req.resume();
      if (opts.mcp.kind === 'hang') {
        held.add(res);
        return;
      }
      timers.push(
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                serverInfo: { name: 'd' },
              },
            }),
          );
        }, opts.mcp.afterMs),
      );
      return;
    }
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        for (const r of held) r.destroy();
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

function activeKindOf(session: InstanceType<typeof StdioSession>): string {
  return (session as unknown as { router: { getActiveKind(): string } }).router.getActiveKind();
}

describe('StdioSession adaptive proxy timeout (TRA-1605)', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await cleanup?.();
    cleanup = null;
    localLandings.length = 0;
    vi.clearAllMocks();
  });

  async function handshakeAgainst(
    daemonPort: number,
    sessionOpts: { proxyInitializeTimeoutMs?: number; proxyWarmupGraceMs?: number } = {},
  ): Promise<{ ms: number; frames: unknown[]; kind: string; localStarts: number }> {
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
      autoSpawnDaemon: false,
      handshakeTimeoutMs: 0,
      trySnapshotFastPath: false,
      stdin,
      stdout,
      ...sessionOpts,
    });
    const previous = cleanup;
    cleanup = async () => {
      await session.shutdown('test');
      await previous?.();
    };

    const frames: unknown[] = [];
    let onFirst: (() => void) | null = null;
    stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) frames.push(JSON.parse(line));
      }
      onFirst?.();
      onFirst = null;
    });
    const firstFrame = new Promise<void>((resolve) => {
      onFirst = resolve;
    });

    const started = Date.now();
    await session.bootstrap();
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);

    await Promise.race([
      firstFrame,
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('no initialize response within 15s')), 15_000);
        t.unref?.();
      }),
    ]);
    const ms = Date.now() - started;
    // Settle window: a late duplicate response for an id we already answered
    // is exactly the failure mode a first-frame-only assertion misses.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 500);
      t.unref?.();
    });
    return { ms, frames, kind: activeKindOf(session), localStarts: localLandings.length };
  }

  it('healthy fast daemon: handshake completes inside the base budget (PROXY path not slowed)', async () => {
    const daemon = await startFakeDaemon({
      health: { ok: true, status: 'healthy' },
      mcp: { kind: 'answer', afterMs: 50 },
    });
    cleanup = () => daemon.close();

    const { ms, frames, kind, localStarts } = await handshakeAgainst(daemon.port);

    expect(responsesFor(frames, 1)).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(responsesFor(frames, 1)[0]))).toMatchObject({ id: 1 });
    expect(kind).toBe('proxy');
    expect(localStarts).toBe(0);
    expect(ms).toBeLessThan(1_000);
  });

  it('warming daemon that answers late: waits past the base budget instead of falling back', async () => {
    const daemon = await startFakeDaemon({
      health: { status: 'starting', phase: 'startup_index', transport: 'http' },
      mcp: { kind: 'answer', afterMs: 1_500 },
    });
    cleanup = () => daemon.close();

    // Base 1 s would have fallen back at ~1 s; the starting signal grants
    // the 8 s grace, and the daemon answers at 1.5 s through the proxy.
    const { ms, frames, kind, localStarts } = await handshakeAgainst(daemon.port, {
      proxyWarmupGraceMs: 8_000,
    });

    expect(responsesFor(frames, 1)).toHaveLength(1);
    expect(kind).toBe('proxy');
    expect(localStarts).toBe(0);
    expect(ms).toBeGreaterThan(1_000);
    expect(ms).toBeLessThan(9_000);
  });

  it('warming daemon that never answers: falls back after the bounded grace (no pinning)', async () => {
    const daemon = await startFakeDaemon({
      health: { status: 'starting', phase: 'startup_index', transport: 'http' },
      mcp: { kind: 'hang' },
    });
    cleanup = () => daemon.close();

    const { ms, frames, kind, localStarts } = await handshakeAgainst(daemon.port, {
      proxyWarmupGraceMs: 1_500,
    });

    // Fallback still happens — at ~base (1 s) + grace (1.5 s), not at 1 s
    // (which would ignore the warming signal) and not never (which would pin).
    expect(responsesFor(frames, 1)).toHaveLength(1);
    expect(kind).toBe('local');
    expect(localStarts).toBe(1);
    expect(ms).toBeGreaterThan(2_000);
    expect(ms).toBeLessThan(8_000);
  });
});
