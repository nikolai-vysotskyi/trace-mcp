/**
 * #209 follow-up: a registered ANCESTOR of other registered roots (e.g. an
 * umbrella folder containing several already-registered repos) independently
 * watched and indexed every descendant's subtree — every descendant file
 * change fired two full watcher-driven reindex passes (ancestor + the
 * descendant's own project).
 *
 * `descendantExcludeGlobs()` / `registeredDescendantRoots()` (registry.ts)
 * already scope the ancestor's *indexing* passes (collectFiles + indexFiles —
 * see registry-health.test.ts). This file pins the remaining piece: the
 * ancestor's live FileWatcher subscription must also pick up a fresh exclude
 * list whenever a project is registered or removed underneath it, instead of
 * running forever with the ignore list it was started with.
 *
 * We mock IndexingPipeline + FileWatcher + createServer so ProjectManager's
 * heavy machinery (real DB, real @parcel/watcher, real MCP server) never
 * starts — only the ancestor-watcher-restart wiring is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface FakeWatcherCall {
  root: string;
  descendantExcludeGlobs: string[];
}

const watcherStartCalls: FakeWatcherCall[] = [];
const watcherRestartCalls: FakeWatcherCall[] = [];

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
    private root = '';
    async start(rootPath: string, _config: unknown, ..._rest: unknown[]) {
      this.root = rootPath;
      const opts = _rest[_rest.length - 1] as { descendantExcludeGlobs?: string[] } | undefined;
      watcherStartCalls.push({
        root: rootPath,
        descendantExcludeGlobs: opts?.descendantExcludeGlobs ?? [],
      });
    }
    async restartWithExcludes(descendantExcludeGlobs: string[]) {
      watcherRestartCalls.push({ root: this.root, descendantExcludeGlobs });
    }
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
let umbrella: string;
let child: string;
let pmRef: { shutdown(): Promise<void> } | undefined;

function makeProjectDir(...segments: string[]): string {
  const dir = join(tmpHome, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  watcherStartCalls.length = 0;
  watcherRestartCalls.length = 0;
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-ancestor-watcher-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  umbrella = makeProjectDir('ws');
  child = makeProjectDir('ws', 'child-repo');
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

describe('ProjectManager ancestor watcher restart (#209)', () => {
  it('restarts an already-managed ancestor watcher when a descendant is registered under it', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    await pm.addProject(umbrella);
    // Ancestor started with no descendants registered yet.
    expect(watcherStartCalls.at(-1)).toMatchObject({ root: umbrella, descendantExcludeGlobs: [] });

    await pm.addProject(child);

    // The umbrella's watcher must have been restarted with an exclude glob
    // covering the newly-registered child, so its subtree is dropped from
    // both the native ignore list and the per-event guard.
    expect(watcherRestartCalls).toContainEqual({
      root: umbrella,
      descendantExcludeGlobs: ['child-repo/**'],
    });
  }, 30_000);

  it('restarts the ancestor watcher again when the descendant is removed', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    await pm.addProject(umbrella);
    await pm.addProject(child);
    watcherRestartCalls.length = 0;

    await pm.removeProject(child, { keepDbFiles: true });

    expect(watcherRestartCalls).toContainEqual({
      root: umbrella,
      descendantExcludeGlobs: [],
    });
  }, 30_000);

  it('does not restart unrelated (sibling) project watchers', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const sibling = makeProjectDir('other-repo');
    await pm.addProject(sibling);
    await pm.addProject(umbrella);
    watcherRestartCalls.length = 0;

    await pm.addProject(child);

    expect(watcherRestartCalls.some((c) => c.root === sibling)).toBe(false);
  }, 30_000);
});
