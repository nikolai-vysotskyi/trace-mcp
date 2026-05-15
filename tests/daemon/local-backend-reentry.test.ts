import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Re-entry guard for LocalBackend.start().
 *
 * If start() is called twice without an intervening stop(), the second
 * call must NOT clobber this.db / this.watcher / this.pipeline etc.
 * Concurrent re-entry (second call before the first resolves) must also
 * deduplicate — both callers receive the same underlying init.
 *
 * Heavy collaborators are stubbed so the test runs in <1s.
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

// In-memory fake DB handle — just needs .close() and to be passed around.
const makeFakeDb = () => ({
  close: vi.fn(),
  exec: vi.fn(),
  prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) })),
  pragma: vi.fn(),
  inTransaction: false,
});

const initializeDatabaseMock = vi.fn(() => makeFakeDb());
vi.mock('../../src/db/schema.js', () => ({
  initializeDatabase: initializeDatabaseMock,
}));

vi.mock('../../src/db/store.js', () => ({
  Store: class FakeStore {
    db: unknown;
    constructor(db: unknown) {
      this.db = db;
    }
  },
}));

vi.mock('../../src/global.js', () => ({
  ensureGlobalDirs: vi.fn(),
  TOPOLOGY_DB_PATH: '/tmp/never-exists-topology.db',
  DECISIONS_DB_PATH: '/tmp/never-exists-decisions.db',
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

vi.mock('../../src/indexer/pipeline.js', () => ({
  IndexingPipeline: class FakeIndexingPipeline {
    async indexAll(): Promise<void> {}
    async indexFiles(): Promise<void> {}
    deleteFiles(): void {}
    async dispose(): Promise<void> {}
  },
}));

const watcherStartMock = vi.fn(async () => undefined);
const watcherStopMock = vi.fn(async () => undefined);
vi.mock('../../src/indexer/watcher.js', () => ({
  FileWatcher: class FakeFileWatcher {
    start = watcherStartMock;
    stop = watcherStopMock;
  },
}));

vi.mock('../../src/pipeline/index.js', () => ({
  SqliteTaskCache: class FakeSqliteTaskCache {},
}));

vi.mock('../../src/ai/index.js', () => ({
  createAIProvider: vi.fn(() => ({
    embedding: vi.fn(),
    fastInference: vi.fn(),
  })),
  BlobVectorStore: class FakeBlobVectorStore {},
  CachedInferenceService: class FakeCachedInferenceService {},
  EmbeddingPipeline: class FakeEmbeddingPipeline {},
  InferenceCache: class FakeInferenceCache {
    evictExpired(): void {}
  },
}));

vi.mock('../../src/ai/summarization-pipeline.js', () => ({
  SummarizationPipeline: class FakeSummarizationPipeline {},
}));

vi.mock('../../src/memory/decision-store.js', () => ({
  DecisionStore: class FakeDecisionStore {},
}));

vi.mock('../../src/topology/topology-db.js', () => ({
  TopologyStore: class FakeTopologyStore {},
}));

const serverDispose = vi.fn();
vi.mock('../../src/server/server.js', () => ({
  createServer: vi.fn(() => ({
    server: {
      connect: vi.fn(async () => undefined),
    },
    dispose: serverDispose,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/inMemory.js', () => ({
  InMemoryTransport: {
    createLinkedPair: vi.fn(() => {
      const client = {
        onmessage: undefined as unknown,
        onerror: undefined as unknown,
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
      };
      const server = {
        onmessage: undefined as unknown,
        onerror: undefined as unknown,
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
      };
      return [client, server];
    }),
  },
}));

// Import LocalBackend AFTER vi.mock calls.
const { LocalBackend } = await import('../../src/daemon/router/local-backend.js');
import type { TraceMcpConfig } from '../../src/config.js';

function makeBackend() {
  const config = {
    ai: { enabled: false },
    topology: { enabled: false },
    indexer: { workers: 1 },
  } as unknown as TraceMcpConfig;
  return new LocalBackend({
    projectRoot: '/tmp/trace-mcp-test-project',
    indexRoot: '/tmp/trace-mcp-test-project',
    config,
    sharedDbPath: '/tmp/trace-mcp-reentry.db',
  });
}

describe('LocalBackend.start() re-entry guard', () => {
  beforeEach(() => {
    initializeDatabaseMock.mockClear();
    watcherStartMock.mockClear();
    watcherStopMock.mockClear();
    serverDispose.mockClear();
  });

  it('second sequential start() is idempotent — no new DB/watcher created', async () => {
    const backend = makeBackend();
    await backend.start();
    const dbCallsAfterFirst = initializeDatabaseMock.mock.calls.length;
    const watcherCallsAfterFirst = watcherStartMock.mock.calls.length;

    // Capture private fields via cast — we want to assert they don't change.
    const internals = backend as unknown as {
      db: unknown;
      watcher: unknown;
      pipeline: unknown;
      store: unknown;
      extractPool: unknown;
      clientTransport: unknown;
    };
    const firstDb = internals.db;
    const firstWatcher = internals.watcher;
    const firstPipeline = internals.pipeline;
    const firstStore = internals.store;
    const firstPool = internals.extractPool;
    const firstClient = internals.clientTransport;

    // Second call — must be a no-op.
    await backend.start();

    expect(initializeDatabaseMock.mock.calls.length).toBe(dbCallsAfterFirst);
    expect(watcherStartMock.mock.calls.length).toBe(watcherCallsAfterFirst);
    expect(internals.db).toBe(firstDb);
    expect(internals.watcher).toBe(firstWatcher);
    expect(internals.pipeline).toBe(firstPipeline);
    expect(internals.store).toBe(firstStore);
    expect(internals.extractPool).toBe(firstPool);
    expect(internals.clientTransport).toBe(firstClient);

    await backend.stop();
  });

  it('concurrent start()/start() — both resolve, only one init runs', async () => {
    const backend = makeBackend();

    // Kick off both without awaiting the first.
    const p1 = backend.start();
    const p2 = backend.start();
    await Promise.all([p1, p2]);

    // Exactly one initializeDatabase + one watcher.start call.
    expect(initializeDatabaseMock.mock.calls.length).toBe(1);
    expect(watcherStartMock.mock.calls.length).toBe(1);

    await backend.stop();
  });

  it('start() → stop() → start() — both starts get fresh resources', async () => {
    const backend = makeBackend();

    await backend.start();
    const firstInitCalls = initializeDatabaseMock.mock.calls.length;
    const firstWatcherCalls = watcherStartMock.mock.calls.length;

    await backend.stop();
    // Wait for background dispose to finish so DB is actually closed before
    // we ask for a fresh one.
    if (backend.backgroundDispose) await backend.backgroundDispose;

    await backend.start();
    expect(initializeDatabaseMock.mock.calls.length).toBe(firstInitCalls + 1);
    expect(watcherStartMock.mock.calls.length).toBe(firstWatcherCalls + 1);

    await backend.stop();
  });
});
