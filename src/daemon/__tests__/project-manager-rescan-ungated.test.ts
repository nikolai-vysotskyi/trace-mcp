/**
 * ProjectManager watcher rescan with an unset limiter (TRA-1138).
 *
 * Lives in its own file on purpose (TRA-1839), not next to the gating test:
 * both tests share module-level mock state (`rescanCallbacks`, `tmpHome`),
 * and vitest does NOT cancel a test whose `it` timeout fires — the orphaned
 * async fn keeps running. On a pathological windows-latest runner (Sep 2026)
 * the gating test's 30s timeout fired mid-`addProject`; the orphan then
 * reassigned `tmpHome` and appended callbacks under the ungated test, which
 * picked up a stale callback pointing at an afterEach-deleted directory and
 * failed with `expected +0 to be 1`. Separate files get separate module
 * registries, so no timeout in another test can contaminate this one.
 *
 * Same mocking harness as project-manager-rescan-gated.test.ts: fake
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
  rescanCallbacks.length = 0;
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-rescan-ungated-'));
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

describe('ProjectManager watcher rescan with unset limiter (TRA-1138)', () => {
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
    // The only callback in this file's registry is ours — no sibling test
    // can append a stale one (TRA-1839). Assert it, so a future merge back
    // into a shared file fails loudly instead of testing the wrong callback.
    expect(rescanCallbacks).toHaveLength(1);
    const rescan = rescanCallbacks[0];

    await pm.shutdown();
    pmRef = undefined;
    peakIndexAll = 0;

    // The defensive branch must not throw on the null limiter.
    await expect(rescan()).resolves.toBeUndefined();
    expect(peakIndexAll).toBe(1);
  }, 30_000);
});
