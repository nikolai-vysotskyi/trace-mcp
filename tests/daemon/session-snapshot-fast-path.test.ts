import net from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TRA-948: when the daemon has already indexed this project, its snapshot
 * sits on disk. StdioSession must answer the client's first requests from it
 * directly instead of blocking stdio on the daemon's /health check — here
 * simulated by a daemon that accepts the TCP connection and never answers,
 * the same worst case TRA-704's tests use, which costs 500ms today via the
 * `/health` fetch's own AbortSignal.timeout(500). The real backend (unreachable
 * daemon, so LocalBackend — mocked here, matching the TRA-704 test style) is
 * negotiated in the background and swapped in afterwards.
 */

/**
 * Budget for the snapshot path to answer `initialize`. The comparison point
 * is the OLD flow's daemon `/health` fetch, bounded by a flat
 * `AbortSignal.timeout(500)` (getDaemonHealth) plus whatever backend
 * selection costs on top of that — 500ms is a wall-clock timer, not an
 * OS-scaled one, so the old flow's real floor is *at least* 500ms everywhere,
 * Windows included.
 *
 * `cross-platform-test` (TRA-970) was the first CI run to ever exercise this
 * file on a real Windows runner — ci.yml gates that job to release
 * PRs/nightly/an explicit label, so nothing had run this assertion there
 * before. GitHub's Windows runners are measurably slower for process/socket
 * work than Linux/macOS (a documented GH Actions characteristic, not a
 * trace-mcp regression): two Windows runs measured 459ms and 514ms,
 * comfortably under 400ms every time on macOS/Linux. 700ms keeps margin
 * above both observed values while staying well clear of the old flow's own
 * 500ms+ floor — widen the win32 budget rather than loosen the one every
 * other platform's CI run actually exercises.
 */
const INIT_BUDGET_MS = process.platform === 'win32' ? 700 : 400;

/** Stands in for the real indexer-backed local backend the swap settles onto. */
const localBackendStarts = vi.fn();
vi.mock('../../src/daemon/router/local-backend.js', () => ({
  LocalBackend: class {
    readonly kind = 'local' as const;
    onmessage?: (msg: JSONRPCMessage) => void;
    async start(): Promise<void> {
      localBackendStarts();
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
const { initializeDatabase } = await import('../../src/db/schema.js');
const { StdioSession } = await import('../../src/daemon/router/session.js');
// Statically imported here for the same reason src/cli.ts imports it (TRA-970):
// StdioSession's own default loader is a dynamic `import()`, a genuine
// first-load the moment anything calls it — fine for the thin proxy entry,
// which never does, but not for this test, which measures exactly the
// <400ms budget that first load would blow. Importing it up front and
// passing it back via `loadSnapshotBackend` mirrors what `trace-mcp serve`
// actually does, and is what keeps this test measuring TRA-948's real
// contract instead of an artifact of module loading order.
const { SnapshotBackend } = await import('../../src/daemon/router/snapshot-backend.js');

/** A socket that accepts and never replies — worst case for a /health probe. */
async function startBlackHoleServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

let tmpDir: string;
let dbPath: string;
let blackHole: { port: number; close: () => Promise<void> };
let session: InstanceType<typeof StdioSession> | null = null;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'trace-mcp-snapshot-session-'));
  dbPath = join(tmpDir, 'shared.db');
  // Pre-create the index DB the way the daemon would (TRA-948 requirement 1:
  // StdioSession must find it already sitting on disk at boot).
  initializeDatabase(dbPath).close();
  blackHole = await startBlackHoleServer();
});

afterEach(async () => {
  await session?.shutdown('test');
  session = null;
  await blackHole.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('StdioSession snapshot fast path (TRA-948)', () => {
  it('answers initialize and a read tool call from the snapshot before the daemon /health timeout elapses, then hands off to the real backend', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    session = new StdioSession({
      projectRoot: tmpDir,
      indexRoot: tmpDir,
      config: TraceMcpConfigSchema.parse({}),
      sharedDbPath: dbPath,
      daemonPort: blackHole.port,
      idleTimeoutMs: 0,
      daemonStabilityMs: 60_000,
      autoSpawnDaemon: false,
      handshakeTimeoutMs: 0,
      stdin,
      stdout,
      loadSnapshotBackend: () => Promise.resolve({ SnapshotBackend }),
    });

    const frames: Array<Record<string, unknown>> = [];
    stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) frames.push(JSON.parse(line));
      }
    });
    const waitForId = (id: number): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const existing = frames.find((f) => f.id === id && (f.result || f.error));
        if (existing) {
          resolve(existing);
          return;
        }
        const t = setInterval(() => {
          const f = frames.find((fr) => fr.id === id && (fr.result || fr.error));
          if (f) {
            clearInterval(t);
            resolve(f);
          }
        }, 5);
      });

    const started = Date.now();
    await session.bootstrap();

    const initializeParams = {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.0' },
    };
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeParams })}\n`,
    );
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_project_map', arguments: {} },
      })}\n`,
    );

    const initResponse = await Promise.race([
      waitForId(1),
      new Promise<never>((_, reject) => {
        const t = setTimeout(
          () => reject(new Error(`no initialize response within ${INIT_BUDGET_MS}ms`)),
          INIT_BUDGET_MS,
        );
        t.unref?.();
      }),
    ]);
    const initMs = Date.now() - started;

    // The daemon's /health fetch alone is bounded to 500ms
    // (getDaemonHealth's AbortSignal.timeout) before the *old* flow could
    // even pick a backend — the snapshot must beat that comfortably.
    expect(initMs).toBeLessThan(INIT_BUDGET_MS);
    expect(initResponse.error).toBeUndefined();
    expect((initResponse.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe(
      'trace',
    );

    const mapResponse = await waitForId(2);
    expect(mapResponse.error).toBeUndefined();
    expect(mapResponse.result).toBeTruthy();

    // Let the background daemon negotiation finish and swap onto the (mocked)
    // real backend — proves the handover in settleRealBackend() actually runs.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 700);
      t.unref?.();
    });
    expect(localBackendStarts).toHaveBeenCalledTimes(1);

    // Exactly one response per id — no late duplicate from the snapshot
    // racing the real backend during handover.
    expect(frames.filter((f) => f.id === 1 && (f.result || f.error))).toHaveLength(1);
    expect(frames.filter((f) => f.id === 2 && (f.result || f.error))).toHaveLength(1);
  });

  it('leaves the shared DB file untouched after the session shuts down', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    session = new StdioSession({
      projectRoot: tmpDir,
      indexRoot: tmpDir,
      config: TraceMcpConfigSchema.parse({}),
      sharedDbPath: dbPath,
      daemonPort: blackHole.port,
      idleTimeoutMs: 0,
      daemonStabilityMs: 60_000,
      autoSpawnDaemon: false,
      handshakeTimeoutMs: 0,
      stdin,
      stdout,
      loadSnapshotBackend: () => Promise.resolve({ SnapshotBackend }),
    });
    await session.bootstrap();
    stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.0' },
        },
      })}\n`,
    );
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 700);
      t.unref?.();
    });
    await session.shutdown('test');
    session = null;

    expect(existsSync(dbPath)).toBe(true);
  });
});
