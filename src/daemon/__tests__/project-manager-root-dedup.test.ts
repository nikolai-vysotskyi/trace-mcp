/**
 * TRA-1608: one filesystem root — one managed project — one watcher subscription.
 *
 * The managed-projects map used to be keyed by the raw caller string, so the
 * same root added as `/tmp/ws/` and `/tmp/ws` produced TWO managed projects
 * with TWO live `@parcel/watcher` subscriptions on one directory. The map is
 * now keyed by {@link managerKey} (`path.resolve`), so alternate spellings
 * collapse to the existing entry and no second subscription starts.
 *
 * Mocks follow project-manager-ancestor-watcher.test.ts: only the
 * dedup wiring is under test, never the real DB/pipeline/watcher.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const watcherStartRoots: string[] = [];

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    async indexAll() {
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
    async start(rootPath: string) {
      watcherStartRoots.push(rootPath);
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
  watcherStartRoots.length = 0;
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-root-dedup-'));
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

describe('ProjectManager root dedup (TRA-1608)', () => {
  function makeProjectDir(): string {
    const dir = join(tmpHome, 'proj');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('managerKey collapses trailing-slash / dot / relative spellings', async () => {
    const { managerKey } = await import('../project-manager.js');
    const dir = makeProjectDir();
    expect(managerKey(`${dir}/`)).toBe(dir);
    expect(managerKey(`${dir}/./`)).toBe(dir);
  });

  it('same root via two spellings → one managed project, one watcher subscription', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const dir = makeProjectDir();
    const first = await pm.addProject(`${dir}/`);
    const second = await pm.addProject(dir);

    expect(second).toBe(first);
    expect(pm.listProjects()).toHaveLength(1);
    expect(watcherStartRoots).toHaveLength(1);
    expect(watcherStartRoots[0]).toBe(dir);
  }, 30_000);

  it('getProject resolves alternate spellings to the same entry', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const dir = makeProjectDir();
    const added = await pm.addProject(dir);

    expect(pm.getProject(`${dir}/`)).toBe(added);
    expect(() => pm.touchActivity(`${dir}/.`)).not.toThrow();
  }, 30_000);
});
