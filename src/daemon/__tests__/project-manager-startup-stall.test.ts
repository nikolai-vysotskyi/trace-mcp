/**
 * TRA-1843: the daemon held 4 eager projects in `indexing` for 87+ min with
 * 0% CPU and zero pipeline lines — two never finished `watcher.start()` (no
 * `Project added to daemon` line) while holding both `loadAllRegistered`
 * setup slots, and every setup failure past `projects.set()` left its
 * half-added entry in the map as an eternal `indexing` ghost pinning
 * `projects_indexing`/`sweep_busy`.
 *
 * Mocks follow project-manager-root-dedup.test.ts: only the failure wiring
 * is under test, never the real native watcher (the wedged-subscribe
 * timeout itself is pinned by indexer/__tests__/watcher-subscribe-timeout).
 * A `watcher.start()` that throws here is exactly what the real
 * `FileWatcher` now does past WATCHER_SUBSCRIBE_TIMEOUT_MS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const watcherState = vi.hoisted(() => ({ failingRoots: [] as string[] }));

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    private readonly rootPath: string;
    constructor(_store?: unknown, _registry?: unknown, _config?: unknown, projectRoot?: string) {
      this.rootPath = projectRoot ?? '';
    }
    async indexAll() {
      // A failing root's background chain must settle WITHOUT opening
      // anything else: the real chain's success path runs subproject
      // auto-sync (a live topology.db handle), which outlives the aborted
      // addProject and EBUSYs the afterEach cleanup on Windows. Rejecting
      // exercises the chain's error branch instead — no handles, no race.
      if (watcherState.failingRoots.includes(this.rootPath)) {
        throw new Error(`indexAll failed for ${this.rootPath} (TRA-1843 fixture)`);
      }
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    async indexFiles() {
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    deleteFiles() {}
    async dispose() {}
  }
  // project-manager.ts also imports IndexAbortedError for the background
  // chain's `instanceof` checks — without it the rejection branch throws a
  // TypeError that escapes as an unhandled rejection.
  class FakeIndexAbortedError extends Error {}
  return { IndexingPipeline: FakeIndexingPipeline, IndexAbortedError: FakeIndexAbortedError };
});

vi.mock('../../indexer/watcher.js', () => {
  class FakeWatcher {
    async start(rootPath: string) {
      if (watcherState.failingRoots.includes(rootPath)) {
        throw new Error(
          `File watcher subscribe timed out after 60000ms for ${rootPath} (TRA-1843)`,
        );
      }
    }
    async restartWithExcludes() {}
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

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

let tmpHome: string;
let pmRef: { shutdown(): Promise<void> } | undefined;

beforeEach(() => {
  watcherState.failingRoots.length = 0;
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-startup-stall-'));
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

function makeProjectDir(name: string): string {
  const dir = join(tmpHome, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('addProject failure teardown (TRA-1843)', () => {
  it('a failed watcher start leaves no indexing ghost behind', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { logger } = await import('../../logger.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const dir = makeProjectDir('proj-fail');
    watcherState.failingRoots.push(dir);

    await expect(pm.addProject(dir)).rejects.toThrow(/subscribe timed out/);
    // The half-added entry is gone: nothing pins indexing/sweep_busy, and a
    // later lazy load can retry from a clean map.
    expect(pm.getProject(dir)).toBeUndefined();
    expect(pm.listProjects()).toHaveLength(0);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { projectRoot: dir },
      expect.stringContaining('TRA-1843'),
    );
  }, 30_000);

  it('loadAllRegistered settles and loads the healthy projects when one eager load fails', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { registerProject } = await import('../../registry.js');
    const { logger } = await import('../../logger.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const goodA = makeProjectDir('proj-a');
    const bad = makeProjectDir('proj-bad');
    const goodC = makeProjectDir('proj-c');
    registerProject(goodA);
    registerProject(bad);
    registerProject(goodC);
    watcherState.failingRoots.push(bad);

    await pm.loadAllRegistered();

    const roots = pm
      .listProjects()
      .map((p) => p.root)
      .sort();
    expect(roots).toEqual([goodA, goodC].sort());
    // No ghost: the failed root is absent (lazy retry), not stuck indexing.
    expect(pm.getProject(bad)).toBeUndefined();
    expect(
      pm.listProjects().filter((p) => p.status === 'indexing' || p.status === 'starting'),
    ).toHaveLength(0);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: bad }),
      'Failed to load registered project',
    );
  }, 60_000);
});

describe('warnOnIndexingStalls (TRA-1843)', () => {
  function harness(
    specs: Array<{
      root: string;
      status: 'starting' | 'indexing' | 'ready';
      indexingStartedAt?: number;
    }>,
  ) {
    return (async () => {
      const { ProjectManager } = await import('../project-manager.js');
      const pm = new ProjectManager();
      const projects = (pm as unknown as { projects: Map<string, unknown> }).projects;
      for (const s of specs) {
        projects.set(s.root, {
          root: s.root,
          status: s.status,
          lastAccessedAt: Date.now(),
          ...(s.indexingStartedAt !== undefined ? { indexingStartedAt: s.indexingStartedAt } : {}),
        });
      }
      return pm;
    })();
  }

  it('names projects stalled past the threshold, once per episode', async () => {
    const { logger } = await import('../../logger.js');
    const old = Date.now() - 20 * 60_000;
    const pm = await harness([
      { root: '/stuck', status: 'indexing', indexingStartedAt: old },
      { root: '/fresh', status: 'indexing', indexingStartedAt: Date.now() },
      { root: '/done', status: 'ready', indexingStartedAt: old },
      { root: '/legacy', status: 'indexing' },
    ]);

    vi.mocked(logger.warn).mockClear();
    const stalled = pm.warnOnIndexingStalls();
    expect(stalled.map((s) => s.root)).toEqual(['/stuck']);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatchObject({
      projectRoot: '/stuck',
      status: 'indexing',
    });

    // Same durable stall on the next tick: no second line.
    expect(pm.warnOnIndexingStalls().map((s) => s.root)).toEqual(['/stuck']);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
  });

  it('re-warns when a project recovers and stalls again', async () => {
    const { logger } = await import('../../logger.js');
    const old = Date.now() - 20 * 60_000;
    const pm = await harness([{ root: '/flaky', status: 'indexing', indexingStartedAt: old }]);

    vi.mocked(logger.warn).mockClear();
    expect(pm.warnOnIndexingStalls()).toHaveLength(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);

    // Recovery prunes the latch …
    const entry = (pm as unknown as { projects: Map<string, { status: string }> }).projects.get(
      '/flaky',
    )!;
    entry.status = 'ready';
    expect(pm.warnOnIndexingStalls()).toHaveLength(0);

    // … so a re-stall reads as a new episode.
    entry.status = 'indexing';
    (entry as unknown as { indexingStartedAt: number }).indexingStartedAt =
      Date.now() - 20 * 60_000;
    expect(pm.warnOnIndexingStalls()).toHaveLength(1);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(2);
  });
});
