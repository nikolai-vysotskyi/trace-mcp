/**
 * TRA-1127: watcher-driven reindexes across projects were ungated, so every
 * registered project could hold the main thread inside synchronous
 * better-sqlite3 at the same time. Measured on the production daemon (21
 * projects): `/health` accepted the connection and never answered inside 5 s,
 * and a session that cannot reach `/health` falls back to indexing the repo
 * itself — a busy daemon manufacturing N more indexers.
 *
 * The reproduction harness (`scripts/perf/daemon-health-latency.mjs`) shows the
 * latency growing with the number of projects reindexing at once; this test
 * pins the cap that bounds it, without needing a real daemon.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type WatchCb = (paths: string[]) => Promise<void>;

const watchCbs: WatchCb[] = [];
let active = 0;
let maxActive = 0;
let completed = 0;

vi.mock('../../indexer/pipeline.js', () => {
  class FakeIndexingPipeline {
    async indexAll() {
      return { totalFiles: 0, indexed: 0, skipped: 0, errors: 0, durationMs: 0 };
    }
    async indexFiles(paths: string[]) {
      active++;
      maxActive = Math.max(maxActive, active);
      // One macrotask turn stands in for a batch's synchronous SQLite work.
      await new Promise((r) => setTimeout(r, 10));
      active--;
      completed++;
      return {
        totalFiles: paths.length,
        indexed: paths.length,
        skipped: 0,
        errors: 0,
        durationMs: 1,
      };
    }
    deleteFiles() {}
    async dispose() {}
  }
  return { IndexingPipeline: FakeIndexingPipeline };
});

vi.mock('../../indexer/watcher.js', () => {
  class FakeWatcher {
    async start(_root: string, _config: unknown, onChange: WatchCb) {
      watchCbs.push(onChange);
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
    createServer: () => ({ server: { close: async () => undefined }, dispose: () => undefined }),
  };
});

let tmpHome: string;
let pmRef: { shutdown(): Promise<void> } | undefined;

beforeEach(() => {
  watchCbs.length = 0;
  active = 0;
  maxActive = 0;
  completed = 0;
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-watch-conc-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  pmRef = undefined;
});

afterEach(async () => {
  if (pmRef) {
    try {
      await pmRef.shutdown();
    } catch {
      /* half-initialized manager may throw on shutdown */
    }
    pmRef = undefined;
  }
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
}, 30_000);

describe('ProjectManager watcher reindex concurrency (TRA-1127)', () => {
  it('caps concurrent watcher reindexes across projects and still runs them all', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const pm = new ProjectManager();
    pmRef = pm;

    for (let i = 0; i < 8; i++) {
      const dir = join(tmpHome, `repo-${i}`);
      mkdirSync(dir, { recursive: true });
      await pm.addProject(dir);
    }
    expect(watchCbs).toHaveLength(8);

    // Every project's watcher fires at once — a bulk checkout, a wake from
    // sleep, or eight agents editing eight repos.
    await Promise.all(watchCbs.map((cb, i) => cb([join(tmpHome, `repo-${i}`, 'a.ts')])));

    expect(completed).toBe(8);
    expect(maxActive).toBeLessThanOrEqual(2);
  }, 30_000);
});
