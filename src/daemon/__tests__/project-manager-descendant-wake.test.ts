/**
 * TRA-1863: a multi-root parent (e.g. `thewed`) intentionally watches its
 * declared children's subtrees too — `registeredDescendantRoots()` excludes
 * declared children from the ancestor's ignore list. When such a child is
 * unloaded (deferred by the eager-load cap at boot, or swept as idle) while
 * the parent stays resident, IDE-only edits inside the child are seen ONLY
 * by the parent's watcher: the child's own DB rots, and query routing
 * (`resolveDeepestKnownRoot` prefers the deepest root) keeps serving that
 * stale child DB.
 *
 * The parent's watcher callback must therefore kick a lazy reload of the
 * unloaded registered descendant instead of letting it rot.
 *
 * Same mocking harness as project-manager-ancestor-watcher.test.ts, except
 * the fake watcher also captures each root's onChanges callback so tests can
 * simulate fs events without a real @parcel/watcher.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const watcherStartCalls: Array<{ root: string; descendantExcludeGlobs: string[] }> = [];
const watcherRestartCalls: Array<{ root: string; descendantExcludeGlobs: string[] }> = [];
const watcherHandlers = new Map<string, (paths: string[]) => Promise<void>>();

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
    async start(
      rootPath: string,
      _config: unknown,
      onChanges: (paths: string[]) => Promise<void>,
      ..._rest: unknown[]
    ) {
      this.root = rootPath;
      const opts = _rest[_rest.length - 1] as { descendantExcludeGlobs?: string[] } | undefined;
      watcherStartCalls.push({
        root: rootPath,
        descendantExcludeGlobs: opts?.descendantExcludeGlobs ?? [],
      });
      watcherHandlers.set(rootPath, onChanges);
    }
    async restartWithExcludes(descendantExcludeGlobs: string[]) {
      watcherRestartCalls.push({ root: this.root, descendantExcludeGlobs });
    }
    async stop() {}
    async unsubscribe() {}
    async drain() {}
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

function makeProjectDir(...segments: string[]): string {
  const dir = join(tmpHome, ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until `cond()` is true or the deadline passes; returns the last value. */
async function pollFor(cond: () => boolean, deadlineMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (cond()) return true;
    if (Date.now() >= deadline) return cond();
    await sleep(50);
  }
}

beforeEach(() => {
  watcherStartCalls.length = 0;
  watcherRestartCalls.length = 0;
  watcherHandlers.clear();
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-descendant-wake-'));
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

describe('ProjectManager descendant wake (TRA-1863)', () => {
  it('reloads a registered-but-unloaded descendant when the ancestor watcher sees its files change', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { setupProject } = await import('../../project-setup.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const umbrella = makeProjectDir('ws');
    const child = makeProjectDir('ws', 'child-repo');
    const childFile = join(child, 'index.ts');
    writeFileSync(childFile, 'export const x = 1;\n');

    await pm.addProject(umbrella);
    // Register the child without loading it (mirrors boot-time deferral).
    setupProject(child);
    expect(pm.getProject(child)).toBeUndefined();

    const startsBefore = watcherStartCalls.filter((c) => c.root === child).length;
    await watcherHandlers.get(umbrella)?.([childFile]);
    // The wake is fire-and-forget — wait for the kicked load to subscribe.
    const woke = await pollFor(() => watcherStartCalls.some((c) => c.root === child));
    expect(woke).toBe(true);
    expect(watcherStartCalls.filter((c) => c.root === child).length).toBe(startsBefore + 1);
    expect(pm.getProject(child)?.status).toBe('ready');
  }, 60_000); // TRA-1854: cold import on loaded windows runners.

  it('does not wake a descendant that is already resident', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const umbrella = makeProjectDir('ws');
    const child = makeProjectDir('ws', 'child-repo');
    const childFile = join(child, 'index.ts');
    writeFileSync(childFile, 'export const x = 1;\n');

    await pm.addProject(umbrella);
    await pm.addProject(child);
    const startsAfterLoad = watcherStartCalls.filter((c) => c.root === child).length;
    expect(startsAfterLoad).toBe(1);

    await watcherHandlers.get(umbrella)?.([childFile]);
    await sleep(500);
    expect(watcherStartCalls.filter((c) => c.root === child).length).toBe(startsAfterLoad);
  }, 60_000);

  it('cooldown suppresses a second wake right after the child unloads again', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { setupProject } = await import('../../project-setup.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const umbrella = makeProjectDir('ws');
    const child = makeProjectDir('ws', 'child-repo');
    const childFile = join(child, 'index.ts');
    writeFileSync(childFile, 'export const x = 1;\n');

    await pm.addProject(umbrella);
    setupProject(child);

    await watcherHandlers.get(umbrella)?.([childFile]);
    await pollFor(() => pm.getProject(child)?.status === 'ready');
    const startsAfterWake = watcherStartCalls.filter((c) => c.root === child).length;
    expect(startsAfterWake).toBe(1);

    // Evict the child again and fire immediately — the cooldown must hold.
    pm.getProject(child)!.lastAccessedAt = 0;
    await pm.unloadIdleProjects(30 * 60_000);
    expect(pm.getProject(child)).toBeUndefined();

    await watcherHandlers.get(umbrella)?.([childFile]);
    await sleep(1500);
    expect(watcherStartCalls.filter((c) => c.root === child).length).toBe(startsAfterWake);
    expect(pm.getProject(child)).toBeUndefined();
  }, 60_000);

  it('caps wakes per batch so a bulk touch cannot recreate the boot herd', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { setupProject } = await import('../../project-setup.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const umbrella = makeProjectDir('ws');
    const touched: string[] = [];
    for (let i = 0; i < 7; i++) {
      const child = makeProjectDir('ws', `child-${i}`);
      const f = join(child, 'index.ts');
      writeFileSync(f, 'export const x = 1;\n');
      setupProject(child);
      touched.push(f);
    }

    await pm.addProject(umbrella);
    await watcherHandlers.get(umbrella)?.(touched);

    // Settle: wait until no new child subscriptions appear for 1s.
    const childStarts = () => watcherStartCalls.filter((c) => c.root !== umbrella).length;
    const deadline = Date.now() + 25_000;
    let last = -1;
    let stableSince = Date.now();
    for (;;) {
      const n = childStarts();
      if (n !== last) {
        last = n;
        stableSince = Date.now();
      }
      if (Date.now() - stableSince >= 1000) break;
      if (Date.now() >= deadline) break;
      await sleep(100);
    }
    expect(childStarts()).toBeLessThanOrEqual(5);
    expect(childStarts()).toBeGreaterThan(0);
  }, 60_000);
});
