import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fallback-storm guard (TRA-1605, PROC-1).
 *
 * On a loaded machine N stdio sessions can hit local mode at once while the
 * daemon is down. A full local `indexAll` costs up to ~880 MB plus its own
 * ExtractPool/ONNX runtime per session — the storm presses the machine
 * exactly when it is already at its limit. The cross-process file lock
 * (`src/utils/pid-lock.ts`, claimed per project in LocalBackend) serializes
 * the full index: one session indexes and publishes its DB to the shared
 * path, the rest seed from it and stay read-only.
 *
 * Heavy collaborators are stubbed (same boilerplate as
 * local-backend-readonly.test.ts); the lock + coordination run for real
 * against a tmp dir, which is what this file pins:
 *   8 parallel daemonless sessions → 1 indexAll, 1 watcher, 7 read-only.
 */

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

const makeFakeDb = () => ({
  close: vi.fn(),
  exec: vi.fn(),
  prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
  pragma: vi.fn(),
  inTransaction: false,
});
vi.mock('../../src/db/schema.js', () => ({ initializeDatabase: vi.fn(() => makeFakeDb()) }));
vi.mock('../../src/db/store.js', () => ({
  Store: class FakeStore {
    db: unknown;
    constructor(db: unknown) {
      this.db = db;
    }
  },
}));
vi.mock('../../src/progress.js', () => ({
  ProgressState: class FakeProgressState {},
  writeServerPid: vi.fn(),
  clearServerPid: vi.fn(),
}));
vi.mock('../../src/plugin-api/registry.js', () => ({
  PluginRegistry: { createWithDefaults: vi.fn(() => ({})) },
}));
vi.mock('../../src/indexer/extract-pool.js', () => ({
  ExtractPool: class FakeExtractPool {
    async terminate(): Promise<void> {}
  },
}));

// The winner's index takes a beat; losers must observe the held lock (not a
// free one) for the test to mean anything. `winnerDone` flips only when the
// winner's indexAll resolves — the stubbed seed mirrors "the winner
// published" from that moment on.
let winnerDone = false;
const indexAllMock = vi.fn(async () => undefined);
vi.mock('../../src/indexer/pipeline.js', () => ({
  IndexingPipeline: class FakeIndexingPipeline {
    indexAll = indexAllMock;
    async indexFiles(): Promise<void> {}
    deleteFiles(): void {}
    async dispose(): Promise<void> {}
  },
}));

const watcherStartMock = vi.fn(async () => undefined);
vi.mock('../../src/indexer/watcher.js', () => ({
  FileWatcher: class FakeFileWatcher {
    start = watcherStartMock;
    stop = vi.fn(async () => undefined);
  },
}));

vi.mock('../../src/pipeline/index.js', () => ({ SqliteTaskCache: class FakeSqliteTaskCache {} }));
vi.mock('../../src/ai/index.js', () => ({
  createAIProvider: vi.fn(() => ({ embedding: vi.fn(), fastInference: vi.fn() })),
  BlobVectorStore: class {},
  CachedInferenceService: class {},
  EmbeddingPipeline: class {},
  InferenceCache: class {
    evictExpired(): void {}
  },
}));
vi.mock('../../src/ai/summarization-pipeline.js', () => ({ SummarizationPipeline: class {} }));
vi.mock('../../src/memory/decision-store.js', () => ({ DecisionStore: class {} }));
vi.mock('../../src/topology/topology-db.js', () => ({ TopologyStore: class {} }));
vi.mock('../../src/server/server.js', () => ({
  createServer: vi.fn(() => ({
    server: { connect: vi.fn(async () => undefined) },
    dispose: vi.fn(),
  })),
}));
vi.mock('@modelcontextprotocol/sdk/inMemory.js', () => ({
  InMemoryTransport: {
    createLinkedPair: vi.fn(() => {
      const mk = () => ({
        onmessage: undefined as unknown,
        onerror: undefined as unknown,
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
      });
      return [mk(), mk()];
    }),
  },
}));

// Real lock + publish + sweep; only the seed is controllable: false while the
// daemon is "down", true once the winner "published".
const seedMock = vi.fn(async () => winnerDone);
vi.mock('../../src/daemon/router/session-db.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  seedSessionDbFromShared: seedMock,
}));

const { LocalBackend } = await import('../../src/daemon/router/local-backend.js');
const { LOCKS_DIR, projectHash } = await import('../../src/global.js');
import type { TraceMcpConfig } from '../../src/config.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-storm-'));
  winnerDone = false;
  seedMock.mockClear();
  indexAllMock.mockClear();
  watcherStartMock.mockClear();
  indexAllMock.mockImplementation(async () => undefined);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeBackend(sharedDbPath: string) {
  const config = {
    ai: { enabled: false },
    topology: { enabled: false },
    indexer: { workers: 1 },
  } as unknown as TraceMcpConfig;
  return new LocalBackend({
    projectRoot: path.join(dir, 'proj'),
    indexRoot: path.join(dir, 'proj'),
    config,
    sharedDbPath,
    localIndexWaitMs: 10_000,
  });
}

function readOnlyOf(backend: InstanceType<typeof LocalBackend>): boolean {
  return (backend as unknown as { readOnly: boolean }).readOnly;
}

describe('fallback-storm guard (TRA-1605)', () => {
  it('8 parallel daemonless sessions → 1 full index, 0 duplicates, 7 read-only', async () => {
    const shared = path.join(dir, 'storm-shared.db');
    // The winner's index takes 300 ms — long enough that every loser
    // observes the held lock, short enough to keep the suite fast. Only
    // the first indexAll call is the winner's; any second call is the
    // duplicate this guard exists to prevent.
    let calls = 0;
    indexAllMock.mockImplementation(async () => {
      calls++;
      expect(calls).toBe(1);
      await new Promise<void>((r) => setTimeout(r, 300));
      winnerDone = true;
    });

    const backends = Array.from({ length: 8 }, () => makeBackend(shared));
    await Promise.all(backends.map((b) => b.start()));

    expect(indexAllMock).toHaveBeenCalledTimes(1);
    expect(watcherStartMock).toHaveBeenCalledTimes(1);
    const readOnlyFlags = backends.map(readOnlyOf);
    expect(readOnlyFlags.filter(Boolean)).toHaveLength(7);
    expect(readOnlyFlags.filter((r) => !r)).toHaveLength(1);

    await Promise.all(backends.map((b) => b.stop()));
  }, 15_000);

  it('a stale lock from a dead process is taken over (no stranded project)', async () => {
    const shared = path.join(dir, 'stale-shared.db');
    // Plant a lock whose owner can never be alive.
    fs.mkdirSync(LOCKS_DIR, { recursive: true });
    const lockPath = path.join(LOCKS_DIR, `${projectHash(shared)}-local-index.pid`);
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 0x7fffffff,
        started_at: Date.now() - 60_000,
        hostname: os.hostname(),
        op: 'local-index',
      }),
    );

    const backend = makeBackend(shared);
    await backend.start();

    // Takeover: this session became the winner and ran the full index.
    expect(indexAllMock).toHaveBeenCalledTimes(1);
    expect(readOnlyOf(backend)).toBe(false);

    await backend.stop();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('loser wait of 0 still indexes as last resort when nothing is published', async () => {
    // Winner holds the lock forever (index never resolves within the test)
    // and publishes nothing: with no wait budget the session must serve
    // rather than hang — today's behavior, no worse.
    const shared = path.join(dir, 'nowait-shared.db');
    indexAllMock.mockImplementation(async () => {
      await new Promise<void>(() => {});
    });

    const first = makeBackend(shared);
    const firstRunning = first.start();
    // Let the first session claim the lock before the second arrives.
    await new Promise<void>((r) => setTimeout(r, 100));

    const config = {
      ai: { enabled: false },
      topology: { enabled: false },
      indexer: { workers: 1 },
    } as unknown as TraceMcpConfig;
    const second = new LocalBackend({
      projectRoot: path.join(dir, 'proj'),
      indexRoot: path.join(dir, 'proj'),
      config,
      sharedDbPath: shared,
      localIndexWaitMs: 0,
    });
    await second.start();
    await firstRunning;

    expect(indexAllMock).toHaveBeenCalledTimes(2);
    expect(readOnlyOf(second)).toBe(false);

    await second.stop();
    await first.stop();
  }, 15_000);
});
