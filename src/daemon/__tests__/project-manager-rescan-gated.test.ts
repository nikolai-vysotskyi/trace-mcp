/**
 * TRA-1138: the watcher's onRescan callback must go through the same
 * `parallel_initial_index` limiter as initial indexing. onRescan fires when
 * the watcher concludes it dropped fs events — bulk checkout, package
 * install, wake from sleep — and wake from sleep hits every registered
 * project at the same moment. Ungated, N registered projects meant N
 * concurrent full re-walks of their roots, while the identical work at
 * daemon start is capped at 2.
 *
 * Same mocking harness as project-manager-ancestor-watcher.test.ts: fake
 * pipeline + watcher + server so no real DB, @parcel/watcher or MCP server
 * starts. The fake pipeline records concurrent indexAll() depth; the fake
 * watcher hands back the onRescan callback so the test can fire it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let activeIndexAll = 0;
let peakIndexAll = 0;
const rescanCallbacks: Array<() => Promise<void>> = [];

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    async indexAll() {
      activeIndexAll++;
      peakIndexAll = Math.max(peakIndexAll, activeIndexAll);
      await new Promise((r) => setTimeout(r, 20));
      activeIndexAll--;
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
  activeIndexAll = 0;
  peakIndexAll = 0;
  rescanCallbacks.length = 0;
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-rescan-gate-'));
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

describe('ProjectManager watcher rescan gating (TRA-1138)', () => {
  it('caps concurrent rescans at parallel_initial_index, not at project count', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    for (let i = 0; i < 5; i++) {
      const dir = join(tmpHome, `repo-${i}`);
      mkdirSync(dir, { recursive: true });
      await pm.addProject(dir);
    }
    expect(rescanCallbacks).toHaveLength(5);

    // Initial indexing has settled; measure the rescan burst on its own.
    await vi.waitFor(() => expect(activeIndexAll).toBe(0));
    peakIndexAll = 0;

    // Wake from sleep: every watcher fires onRescan at the same moment.
    await Promise.all(rescanCallbacks.map((cb) => cb()));

    expect(peakIndexAll).toBeGreaterThan(0);
    expect(peakIndexAll).toBeLessThanOrEqual(2); // default parallel_initial_index
  }, 30_000);

  // NOT a race test: the real FileWatcher.stop() unsubscribes and then drains
  // the in-flight rescan, and shutdown() clears the limiter only after that,
  // so a live rescan never sees a null limiter (Reviewer C verified this
  // against the unmocked watcher). FakeWatcher.stop() is a no-op, which is
  // what lets the callback be fired here at all. What this pins is only the
  // defensive branch itself: an unset limiter degrades to an ungated re-walk
  // instead of throwing inside a watcher callback.
  it('runs the rescan ungated when the limiter is unset', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    const dir = join(tmpHome, 'repo-solo');
    mkdirSync(dir, { recursive: true });
    await pm.addProject(dir);
    const rescan = rescanCallbacks[0];

    await pm.shutdown();
    pmRef = undefined;
    peakIndexAll = 0;

    // The defensive branch must not throw on the null limiter.
    await expect(rescan()).resolves.toBeUndefined();
    expect(peakIndexAll).toBe(1);
  }, 30_000);
});
