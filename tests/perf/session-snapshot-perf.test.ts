import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TRA-1146: absolute wall-clock budget for the snapshot fast path (TRA-948),
 * deliberately living in tests/perf/** — ci.yml and release.yml exclude that
 * directory from every gate ("flaky timings on shared CI CPU"), so this file
 * is a trend signal for developers (`pnpm exec vitest run tests/perf`), never
 * a release blocker. A functional assertion on rented-hardware wall-clock
 * blocked release 3.23.0 (783ms vs a 700ms budget); the merge-gating contract
 * now lives as a causal ordering assertion in
 * tests/daemon/session-snapshot-fast-path.test.ts and cannot flake on load.
 *
 * The budget below guards a 10x-class regression, not jitter: the old flow's
 * floor is the daemon `/health` fetch's own 500ms AbortSignal timeout plus
 * backend selection on top, and the worst snapshot answer ever observed on a
 * loaded Windows runner was 783ms. 2000ms keeps ~2.5x margin above that while
 * still failing loudly if the snapshot path ever costs seconds again.
 */

const PERF_BUDGET_MS = 2000;
const HANG_TIMEOUT_MS = 15_000;

vi.mock('../../src/daemon/router/local-backend.js', () => ({
  LocalBackend: class {
    readonly kind = 'local' as const;
    onmessage?: (msg: { id?: string | number }) => void;
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async send(msg: { id?: string | number }): Promise<void> {
      const id = msg.id;
      if (id === undefined) return;
      this.onmessage?.({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'x' } },
      });
    }
  },
}));

const { TraceMcpConfigSchema } = await import('../../src/config.js');
const { initializeDatabase } = await import('../../src/db/schema.js');
const { StdioSession } = await import('../../src/daemon/router/session.js');
// Same static import as the functional test (see its TRA-970 comment): the
// session's default loader is a dynamic import() whose first-load cost must
// not be measured here — `trace-mcp serve` pre-loads it the same way.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'trace-mcp-snapshot-perf-'));
  dbPath = join(tmpDir, 'shared.db');
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

describe('snapshot fast path latency (perf, non-gating)', () => {
  it(
    'answers initialize from the snapshot well under the old flow floor',
    async () => {
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
      stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'perf-probe', version: '0.0.0' },
          },
        })}\n`,
      );

      const initResponse = await Promise.race([
        waitForId(1),
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error(`no initialize response within ${HANG_TIMEOUT_MS}ms`)),
            HANG_TIMEOUT_MS,
          );
          t.unref?.();
        }),
      ]);
      const initMs = Date.now() - started;

      expect(initResponse.error).toBeUndefined();
      console.log(`snapshot initialize latency: ${initMs}ms (budget ${PERF_BUDGET_MS}ms)`);
      expect(initMs).toBeLessThan(PERF_BUDGET_MS);
    },
    HANG_TIMEOUT_MS + 5000,
  );
});
