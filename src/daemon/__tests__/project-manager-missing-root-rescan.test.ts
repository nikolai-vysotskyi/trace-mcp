/**
 * TRA-1715: a project whose root was deleted from disk (finished task
 * workdir) must not be re-walked on every FSEvents drop, must stop
 * advertising `ready`, and must drop its watcher.
 *
 * Pins the `onRescan` guard: with the root gone the rescan is skipped
 * (no `indexAll` call), the project is marked `error` immediately so
 * /health tells the truth, and the project is unloaded on the next
 * macrotask — the watcher stops with it, the registry row survives so
 * /health reports `unloaded` (lazy reload on next request, same as the
 * idle-unload path).
 *
 * The unload MUST be deferred past the rescan run itself: stopProject()
 * drains FileWatcher.activeRescan, which IS this run — awaiting it inline
 * would deadlock. The test flushes macrotasks to observe the unload.
 *
 * Same mocking harness as project-manager-rescan-gated.test.ts: fake
 * pipeline + watcher + server so no real DB, @parcel/watcher or MCP
 * server starts (the Store/registry.json on disk are real, scoped to a
 * stubbed TRACE_MCP_DATA_DIR).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let indexAllCalls = 0;
const rescanCallbacks: Array<() => Promise<void>> = [];

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    async indexAll() {
      indexAllCalls++;
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    async indexFiles() {
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    deleteFiles() {}
    async dispose() {}
  }
  return { IndexingPipeline: FakeIndexingPipeline };
});

vi.mock('../../indexer/watcher.js', () => {
  class FakeWatcher {
    async start(_rootPath: string, _config: unknown, ..._rest: unknown[]) {
      const opts = _rest[_rest.length - 1] as { onRescan?: () => Promise<void> } | undefined;
      if (opts?.onRescan) rescanCallbacks.push(opts.onRescan);
    }
    async restartWithExcludes() {}
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

let tmpHome: string;
let pmRef: { shutdown(): Promise<void> } | undefined;

beforeEach(() => {
  indexAllCalls = 0;
  rescanCallbacks.length = 0;
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-missing-rescan-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  pmRef = undefined;
});

afterEach(async () => {
  if (pmRef) {
    try {
      await pmRef.shutdown();
    } catch {
      /* half-initialized manager may throw on shutdown; only care resources release */
    }
    pmRef = undefined;
  }
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
}, 30_000);

/** Flush pending macrotasks (the deferred stopProject runs on setImmediate). */
async function flushImmediate(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe('ProjectManager onRescan with a deleted root (TRA-1715)', () => {
  it('skips the re-walk, marks the project, and unloads it (watcher stops too)', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { listProjects } = await import('../../registry.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const dir = join(tmpHome, 'task-workdir');
    mkdirSync(dir, { recursive: true });
    await pm.addProject(dir);
    expect(rescanCallbacks).toHaveLength(1);
    const initialCalls = indexAllCalls;
    expect(initialCalls).toBeGreaterThan(0);

    // The task finished and its workdir was removed from under the daemon.
    rmSync(dir, { recursive: true, force: true });

    await rescanCallbacks[0]();

    // No re-walk of a dead root.
    expect(indexAllCalls).toBe(initialCalls);
    // Truth in advertising, immediately — before the deferred unload runs.
    expect(pm.getProject(dir)?.status).toBe('error');

    // Deferred unload drops the watcher and frees the slot; the registry
    // row survives so /health reports `unloaded`, not silence.
    await vi.waitFor(
      () => {
        expect(pm.getProject(dir)).toBeUndefined();
        expect(pm.listProjects()).toHaveLength(0);
      },
      { timeout: 10_000, interval: 25 },
    );
    expect(listProjects().map((e) => e.root)).toEqual([dir]);
  }, 30_000);

  it('still rescans a root that exists', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const dir = join(tmpHome, 'live-project');
    mkdirSync(dir, { recursive: true });
    await pm.addProject(dir);
    const before = indexAllCalls;

    await rescanCallbacks[0]();

    expect(indexAllCalls).toBe(before + 1);
    await flushImmediate();
    expect(pm.getProject(dir)?.status).not.toBe('error');
  }, 30_000);
});
