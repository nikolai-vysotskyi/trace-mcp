/**
 * TRA-335: the registry accumulated one row per agent run forever — 135 of 147
 * registered projects were one-shot Multica checkouts. Neither reclaim signal
 * could see them: `prune` reads "root directory still exists" as liveness (the
 * runtime doesn't delete finished checkouts), and `lastIndexed` stays fresh
 * because this very daemon keeps reindexing them. `sweepEphemeralProjects`
 * uses age since registration instead.
 *
 * TRA-396: `registerProject` no longer persists such roots at all, so this
 * sweep now only drains rows written by earlier versions — which is what the
 * tests below construct directly. New checkouts are covered by
 * `tests/registry.test.ts`.
 *
 * Mocks IndexingPipeline + FileWatcher + createServer like
 * project-manager-last-indexed.test.ts so only the sweep wiring is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    async start() {}
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

/** A directory shaped like a one-shot agent-run checkout. */
function makeEphemeralWorkdir(runId: string): string {
  const dir = join(tmpHome, 'multica_workspaces_example.com', 'ws-1', runId, 'workdir');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Backdate a registry entry's `addedAt` so it reads as past the TTL. */
async function backdate(root: string, hours: number): Promise<void> {
  const { REGISTRY_PATH } = await import('../../global.js');
  const reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  reg.projects[root].addedAt = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg));
}

/**
 * Write a one-shot workdir row straight into registry.json, `addedAt` already
 * backdated. Since TRA-396 `registerProject` refuses to persist these, so this
 * is the only way to reproduce what the sweep exists to drain: registries
 * written by an earlier version.
 */
async function writeLegacyEphemeralRow(root: string, ageHours: number): Promise<void> {
  const { ensureGlobalDirs, getDbPath, REGISTRY_PATH } = await import('../../global.js');
  ensureGlobalDirs();
  let reg: { version: number; projects: Record<string, unknown> };
  try {
    reg = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    reg = { version: 1, projects: {} };
  }
  reg.projects[root] = {
    name: root.split('/').pop(),
    root,
    dbPath: getDbPath(root),
    lastIndexed: null,
    addedAt: new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString(),
  };
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg));
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-ephemeral-sweep-'));
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

describe('ProjectManager.sweepEphemeralProjects (TRA-335)', () => {
  it('deregisters a one-shot workdir past the TTL even though its root still exists', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { listProjects } = await import('../../registry.js');

    const stale = makeEphemeralWorkdir('run-old');
    await writeLegacyEphemeralRow(stale, 96);

    const pm = new ProjectManager();
    pmRef = pm;

    expect(await pm.sweepEphemeralProjects(72)).toEqual([stale]);
    expect(listProjects()).toEqual([]);
  }, 30_000);

  it('leaves a recent workdir and a normal project alone', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { listProjects, registerProject } = await import('../../registry.js');

    const fresh = makeEphemeralWorkdir('run-new');
    await writeLegacyEphemeralRow(fresh, 2);

    const normal = join(tmpHome, 'real-project');
    mkdirSync(normal, { recursive: true });
    registerProject(normal);
    await backdate(normal, 1000);

    const pm = new ProjectManager();
    pmRef = pm;

    expect(await pm.sweepEphemeralProjects(72)).toEqual([]);
    expect(
      listProjects()
        .map((e) => e.root)
        .sort(),
    ).toEqual([fresh, normal].sort());
  }, 30_000);

  it('skips a workdir that a run is still holding open', async () => {
    const { ProjectManager } = await import('../project-manager.js');
    const { listProjects } = await import('../../registry.js');

    const busy = makeEphemeralWorkdir('run-busy');
    await writeLegacyEphemeralRow(busy, 96);

    const pm = new ProjectManager();
    pmRef = pm;
    // Stand in for the resource pool's client tracking — the same signal
    // unloadIdleProjects uses to leave a project with live clients alone.
    (pm as unknown as { resourcePool: { getRefCount(root: string): number } }).resourcePool = {
      getRefCount: (root: string) => (root === busy ? 1 : 0),
    };

    expect(await pm.sweepEphemeralProjects(72)).toEqual([]);
    expect(listProjects().map((e) => e.root)).toEqual([busy]);
  }, 30_000);
});
