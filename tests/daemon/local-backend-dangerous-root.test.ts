import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dangerous-root guard for LocalBackend.start() (TRA-893).
 *
 * MCP clients that spawn `trace-mcp serve` with cwd=/ (Claude Desktop does)
 * used to make the local backend index and watch the whole filesystem —
 * ~1.5 GB RSS and permanent ~70% CPU per session. start() must bring up the
 * read side and leave indexAll() + the file watcher untouched.
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
  TRACE_MCP_HOME: '/tmp/never-exists-trace-mcp-home',
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

function makeBackend(projectRoot: string) {
  const config = {
    ai: { enabled: false },
    topology: { enabled: false },
    indexer: { workers: 1 },
  } as unknown as TraceMcpConfig;
  return new LocalBackend({
    projectRoot,
    indexRoot: projectRoot,
    config,
    sharedDbPath: '/nonexistent/trace-mcp-danger.db',
  });
}

describe('LocalBackend dangerous-root guard', () => {
  beforeEach(() => {
    watcherStartMock.mockClear();
    indexAllMock.mockClear();
  });

  it.each(['/', os.homedir(), '/Users', '/etc'])('does not index or watch %s', async (root) => {
    const backend = makeBackend(root);
    await backend.start();

    expect(indexAllMock).not.toHaveBeenCalled();
    expect(watcherStartMock).not.toHaveBeenCalled();

    await backend.stop();
  });

  it('still indexes and watches a real project root', async () => {
    const backend = makeBackend('/nonexistent/trace-mcp-test-project');
    await backend.start();

    expect(indexAllMock).toHaveBeenCalled();
    expect(watcherStartMock).toHaveBeenCalled();

    await backend.stop();
  });
});
