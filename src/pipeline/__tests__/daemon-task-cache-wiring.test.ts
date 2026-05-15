/**
 * Verifies that the daemon's `ProjectManager.addProject` constructs the
 * pipeline with a `SqliteTaskCache`, NOT the default in-memory cache.
 *
 * Motivation: a long-running daemon with multiple projects, each holding an
 * unbounded in-memory pass cache, was the suspected source of the 1.36
 * memory leak. The wiring fix routes the daemon path through the SQLite
 * cache so pass outputs persist on disk and never accumulate in the
 * daemon's resident set. This test pins that wiring so a future refactor
 * cannot silently regress it.
 *
 * We mock `IndexingPipeline` so the daemon's heavy machinery (file watcher,
 * MCP server, AI pipelines) never starts. Only the constructor argument is
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Capture the constructor calls so we can introspect what cache was passed.
const indexingPipelineCalls: unknown[][] = [];

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    constructor(...args: unknown[]) {
      indexingPipelineCalls.push(args);
    }
    async indexAll() {
      return {
        totalFiles: 0,
        indexed: 0,
        skipped: 0,
        errors: 0,
        durationMs: 0,
      };
    }
    async indexFiles() {
      return {
        totalFiles: 0,
        indexed: 0,
        skipped: 0,
        errors: 0,
        durationMs: 0,
      };
    }
    deleteFiles() {}
    async dispose() {}
  }
  return { IndexingPipeline: FakeIndexingPipeline };
});

// Stub the file watcher and MCP server so addProject doesn't actually spin
// up I/O. The wiring under test is purely the cache-construction path.
vi.mock('../../indexer/watcher.js', () => {
  class FakeWatcher {
    async start() {}
    async stop() {}
  }
  return { FileWatcher: FakeWatcher };
});

vi.mock('../../server/server.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    createServer: () => ({
      server: { close: async () => undefined },
      dispose: () => undefined,
    }),
  };
});

let workDir: string;
// Scope `pm` to the outer block so afterEach can drain async background work
// (sharedPool, runSubprojectAutoSync) that would otherwise keep the event
// loop alive past Vitest's per-test timeout.
let pmRef: { shutdown(): Promise<void> } | undefined;

beforeEach(() => {
  indexingPipelineCalls.length = 0;
  workDir = mkdtempSync(join(tmpdir(), 'daemon-task-cache-'));
  pmRef = undefined;
});

afterEach(async () => {
  if (pmRef) {
    try {
      await pmRef.shutdown();
    } catch {
      /* shutdown of a half-initialized manager may throw; we only care that
         outstanding resources release so the test runner can exit. */
    }
    pmRef = undefined;
  }
  rmSync(workDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('ProjectManager → IndexingPipeline taskCache wiring', () => {
  it('passes a SqliteTaskCache instance into IndexingPipeline deps', async () => {
    const { ProjectManager } = await import('../../daemon/project-manager.js');
    const { SqliteTaskCache } = await import('../cache.js');

    const pm = new ProjectManager();
    pmRef = pm;
    try {
      await pm.addProject(workDir);
    } catch {
      // addProject may fail in a tmp dir lacking config; we only care that
      // the constructor was called BEFORE any background indexAll attempt.
    }

    expect(indexingPipelineCalls.length).toBeGreaterThan(0);
    const lastCall = indexingPipelineCalls[indexingPipelineCalls.length - 1];
    // IndexingPipeline(store, registry, config, projectRoot, progress, deps)
    const deps = lastCall[5] as { taskCache?: unknown } | undefined;
    expect(deps).toBeDefined();
    expect(deps?.taskCache).toBeInstanceOf(SqliteTaskCache);
  }, 30_000);
});
