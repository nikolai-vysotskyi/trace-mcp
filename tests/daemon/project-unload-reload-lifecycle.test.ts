/**
 * Unload → reload lifecycle (TRA-1648): a project evicted by the idle-unload
 * sweep must come back fully servable — re-adding it and running a forced
 * reindex (exactly what `POST /api/projects/reindex` does via
 * `resolveProjectForRest` + `pipeline.indexAll(true)`) must succeed with a
 * usable store, never with a raw `database connection is not open` TypeError
 * from a stale closed handle.
 *
 * Uses a real ProjectManager against an isolated TRACE_MCP_DATA_DIR; the
 * fixture root lives in os.tmpdir() so no real index, registry, or project
 * file is touched. Watches nothing (watch:false) and registers nothing
 * (persist:false).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { beginReindex, countReindexingProjects } from '../../src/daemon/reindex-file-handler.js';

vi.mock('../../../src/registry.js', () => ({
  listProjects: vi.fn(() => []),
  unregisterProject: vi.fn(),
  getProject: vi.fn(() => undefined),
  updateLastIndexed: vi.fn(),
  clearPendingReindex: vi.fn(),
  recordPendingReindexAttempt: vi.fn(() => 1),
  findOverlappingProjects: vi.fn(() => []),
}));

vi.mock('../../../src/progress.js', () => ({
  ProgressState: vi.fn(function (this: unknown) {
    return {};
  }),
  clearServerPid: vi.fn(),
  writeServerPid: vi.fn(),
}));

vi.mock('../../../src/project-setup.js', () => ({
  setupProject: vi.fn(),
  isDangerousProjectRoot: vi.fn(() => null),
}));

vi.mock('../../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

// biome-ignore lint/suspicious/noExplicitAny: test-only handles
type AnyManager = any;

let tmpHome: string;
let previousDataDir: string | undefined;
let fixtureRoot: string;
let pm: AnyManager;
let search: AnyManager;

async function loadImpl() {
  const pmMod = await import('../../../src/daemon/project-manager.js');
  const navMod = await import('../../../src/tools/navigation/navigation.js');
  return { ProjectManager: pmMod.ProjectManager, search: navMod.search };
}

beforeAll(async () => {
  previousDataDir = process.env.TRACE_MCP_DATA_DIR;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-pm-lifecycle-'));
  process.env.TRACE_MCP_DATA_DIR = tmpHome;

  const { ProjectManager, search: searchFn } = await loadImpl();
  search = searchFn;

  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-pm-lifecycle-proj-'));
  fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, 'src', 'service.ts'),
    'export class LifecycleProbe { run() { return 1; } }\n',
    'utf-8',
  );

  pm = new ProjectManager();
}, 120_000);

afterAll(async () => {
  try {
    await pm?.shutdown?.();
  } catch {
    /* best-effort */
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.TRACE_MCP_DATA_DIR;
  else process.env.TRACE_MCP_DATA_DIR = previousDataDir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('ProjectManager unload → re-add → forced reindex', () => {
  it('serves reads after an idle-unload + lazy reload cycle', async () => {
    const first = await pm.addProject(fixtureRoot, { watch: false, persist: false });
    await first.initialIndexPromise;
    expect(first.status).toBe('ready');

    // Age it out and run the idle-unload sweep (mirrors the 30 min TTL path).
    // biome-ignore lint/suspicious/noExplicitAny: driving private state like the sibling sweep tests
    (pm as AnyManager).projects.get(fixtureRoot).lastAccessedAt = Date.now() - 60_000;
    const unloaded = await pm.unloadIdleProjects(1_000);
    expect(unloaded).toEqual([fixtureRoot]);

    // Lazy reload (what resolveProjectForRest does for an unloaded root).
    const second = await pm.addProject(fixtureRoot, { watch: false, persist: false });
    await second.initialIndexPromise;
    expect(second.status).toBe('ready');

    // The exact call the HTTP reindex endpoint makes — must not throw the
    // stale-handle TypeError from TRA-1648.
    const result = await second.pipeline.indexAll(true);
    expect(result.errors).toBe(0);

    const found = await search(second.store, 'LifecycleProbe', { kind: 'class' }, 10, 0, {});
    expect(found.items.map((i: { symbol: { name: string } }) => i.symbol.name)).toContain(
      'LifecycleProbe',
    );
  }, 180_000);
});

describe('Endpoint full reindex vs stopProject drain (TRA-1674)', () => {
  it('the stop drain waits for an endpoint-style full reindex instead of closing the DB under it', async () => {
    // Field evidence (2026-09-18): POST /api/projects/reindex fired a
    // fire-and-forget pipeline.indexAll(true) that the idle-unload sweep
    // killed mid-run — stopProject()'s db.close() landed inside
    // reconcileScope's getAllFiles and the run died as a caught "Reindex
    // failed". The single-file paths were already covered by TRA-1553's
    // drain; the full-reindex endpoint was the one path that never
    // registered via beginReindex. This test drives a real ProjectManager
    // through exactly that interleaving, with the run stalled inside
    // collectFiles so the stop is guaranteed to land mid-run.
    const { ProjectManager: PM } = await loadImpl();
    const local: AnyManager = new PM();
    try {
      const managed = await local.addProject(fixtureRoot, { watch: false, persist: false });
      await managed.initialIndexPromise;
      expect(managed.status).toBe('ready');

      const pipeline = managed.pipeline as AnyManager;
      const origCollect: (...args: unknown[]) => Promise<unknown> =
        pipeline.collectFiles.bind(pipeline);
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      pipeline.collectFiles = async (...args: unknown[]) => {
        await gate;
        return origCollect(...args);
      };

      // Exactly what the fixed POST /api/projects/reindex handler does.
      const endReindex = beginReindex(fixtureRoot);
      expect(countReindexingProjects()).toBe(1);
      const run = managed.pipeline.indexAll(true).finally(endReindex);

      const shutdown = local.shutdown();
      // Let shutdown reach the bounded drain, then let the run proceed. The
      // 100 ms only orders the two sides for determinism — the gate, not the
      // sleep, is what makes the interleaving exact.
      await new Promise((r) => setTimeout(r, 100));
      release();
      const result = await run;
      expect(result.errors).toBe(0);
      await shutdown;
      expect(countReindexingProjects()).toBe(0);
    } finally {
      try {
        await local?.shutdown?.();
      } catch {
        /* best-effort — already shut down on the happy path */
      }
    }
  }, 120_000);
});
