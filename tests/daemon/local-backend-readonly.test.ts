import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Read-only fallback for LocalBackend (#209).
 *
 * When the daemon has already indexed a project and seeds this session's DB,
 * the fallback must serve that snapshot WITHOUT running the indexing stack —
 * no indexAll() (which spawns ExtractPool worker threads) and no FileWatcher.
 * That stack is what made each local-mode session cost ~0.4-1.3 GB and pile up
 * to multi-GB across N stdio sessions during a daemon hiccup. In the genuine
 * daemonless case (nothing seeded) full local indexing still runs.
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

// indexAll is the spawn-the-workers operation — the thing read-only must skip.
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

// Controllable seed result — drives the read-only decision.
const seedMock = vi.fn(async () => true);
vi.mock('../../src/daemon/router/session-db.js', () => ({
  seedSessionDbFromShared: seedMock,
  sweepOrphanedSessionDbs: vi.fn(),
}));

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
    sharedDbPath: '/tmp/trace-mcp-readonly.db',
  });
}

describe('LocalBackend read-only fallback', () => {
  beforeEach(() => {
    seedMock.mockClear();
    indexAllMock.mockClear();
    watcherStartMock.mockClear();
  });

  it('seeded from shared DB → read-only: no indexAll, no watcher', async () => {
    seedMock.mockResolvedValue(true);
    const backend = makeBackend();
    await backend.start();

    expect((backend as unknown as { readOnly: boolean }).readOnly).toBe(true);
    expect(indexAllMock).not.toHaveBeenCalled();
    expect(watcherStartMock).not.toHaveBeenCalled();

    await backend.stop();
  });

  it('nothing seeded (daemonless) → full local index: indexAll + watcher run', async () => {
    seedMock.mockResolvedValue(false);
    const backend = makeBackend();
    await backend.start();

    expect((backend as unknown as { readOnly: boolean }).readOnly).toBe(false);
    expect(indexAllMock).toHaveBeenCalledTimes(1);
    expect(watcherStartMock).toHaveBeenCalledTimes(1);

    await backend.stop();
  });
});
