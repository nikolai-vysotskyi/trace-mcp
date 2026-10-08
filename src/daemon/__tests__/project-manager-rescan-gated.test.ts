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
let failNextRescanWithFk = false;
let failForcedRescanWithFk = false;
const forceFlags: boolean[] = [];
const rescanCallbacks: Array<() => Promise<void>> = [];

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    async indexAll(force = false) {
      forceFlags.push(force);
      activeIndexAll++;
      peakIndexAll = Math.max(peakIndexAll, activeIndexAll);
      await new Promise((r) => setTimeout(r, 20));
      activeIndexAll--;
      if (failNextRescanWithFk && !force) {
        failNextRescanWithFk = false;
        throw new Error('FOREIGN KEY constraint failed');
      }
      if (failForcedRescanWithFk && force) throw new Error('FOREIGN KEY constraint failed');
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    async indexFiles() {
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    deleteFiles() {}
    async dispose() {}
  }
  return { IndexingPipeline: FakeIndexingPipeline, IndexAbortedError: class extends Error {} };
});

vi.mock('../../indexer/watcher.js', () => {
  class FakeWatcher {
    async start(_rootPath: string, _config: unknown, ..._rest: unknown[]) {
      const opts = _rest[_rest.length - 1] as { onRescan?: () => Promise<void> } | undefined;
      if (opts?.onRescan) rescanCallbacks.push(opts.onRescan);
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

let tmpHome: string;
let pmRef: { shutdown(): Promise<void> } | undefined;

beforeEach(() => {
  activeIndexAll = 0;
  peakIndexAll = 0;
  failNextRescanWithFk = false;
  failForcedRescanWithFk = false;
  forceFlags.length = 0;
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
  it('retries a dropped-event rescan after a foreign-key failure', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;
    const dir = join(tmpHome, 'repo-fk');
    mkdirSync(dir, { recursive: true });
    await pm.addProject(dir);
    await vi.waitFor(() => expect(pm.getProject(dir)?.status).toBe('ready'));
    expect(rescanCallbacks).toHaveLength(1);

    forceFlags.length = 0;
    failNextRescanWithFk = true;
    await expect(rescanCallbacks[0]()).resolves.toBeUndefined();

    expect(forceFlags).toEqual([false, true]);
    expect(pm.getProject(dir)?.status).toBe('ready');
  }, 60_000);

  it('marks the project unhealthy if the forced retry also fails', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;
    const dir = join(tmpHome, 'repo-persistent-fk');
    mkdirSync(dir, { recursive: true });
    await pm.addProject(dir);
    await vi.waitFor(() => expect(pm.getProject(dir)?.status).toBe('ready'));

    failNextRescanWithFk = true;
    failForcedRescanWithFk = true;
    await expect(rescanCallbacks[0]()).rejects.toThrow('FOREIGN KEY constraint failed');
    expect(pm.getProject(dir)?.status).toBe('error');
  }, 60_000);

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
    // TRA-1579: explicit waitFor budget — the default 1s timeout flakes on
    // loaded Windows runners where 5 projects' initial indexing plus event
    // loop lag exceeds it. The test itself still caps at 30s.
    // TRA-1839: raised to 60s. On a pathological windows-latest runner
    // (Sep 2026) the cold import of the daemon graph plus 5 sequential
    // real-DB addProjects alone approached the 30s cap, and the timeout
    // firing mid-test left the orphaned async fn mutating shared module
    // state under the NEXT test (see project-manager-rescan-ungated.test.ts).
    await vi.waitFor(() => expect(activeIndexAll).toBe(0), { timeout: 10_000, interval: 50 });
    peakIndexAll = 0;

    // Wake from sleep: every watcher fires onRescan at the same moment.
    await Promise.all(rescanCallbacks.map((cb) => cb()));

    expect(peakIndexAll).toBeGreaterThan(0);
    expect(peakIndexAll).toBeLessThanOrEqual(2); // default parallel_initial_index
  }, 60_000);
});
