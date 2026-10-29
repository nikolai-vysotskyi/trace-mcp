/**
 * Cross-project relay cache bounding, eviction, and invalidation (TRA-1719).
 *
 * Covers:
 *  - invalidateProject(root) releasing ServerHandle and purging cache entries
 *  - bounded cache capacity (maxTargets, default 64)
 *  - stale-first eviction: projects unloaded or stopped by ProjectManager are
 *    evicted before live active entries
 *  - LRU eviction when all entries are live
 *  - lightweight relay invalidation and eviction closing underlying DBs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;
let projectA: string;
let projectB: string;
let projectC: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-relay-eviction-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
  projectA = join(tmpHome, 'project-a');
  projectB = join(tmpHome, 'project-b');
  projectC = join(tmpHome, 'project-c');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  mkdirSync(projectC, { recursive: true });
  writeFileSync(join(projectA, 'package.json'), JSON.stringify({ name: 'a' }));
  writeFileSync(join(projectB, 'package.json'), JSON.stringify({ name: 'b' }));
  writeFileSync(join(projectC, 'package.json'), JSON.stringify({ name: 'c' }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(tmpHome, { recursive: true, force: true });
});

async function makeManagedProject(root: string) {
  const { registerProject } = await import('../../src/registry.js');
  const { initializeDatabase } = await import('../../src/db/schema.js');
  const { Store } = await import('../../src/db/store.js');
  const { PluginRegistry } = await import('../../src/plugin-api/registry.js');
  const { ProgressState } = await import('../../src/progress.js');
  const { loadConfig } = await import('../../src/config.js');

  registerProject(root);
  const db = initializeDatabase(join(root, 'test.db'));
  const store = new Store(db);
  const registry = PluginRegistry.createWithDefaults();
  const progress = new ProgressState(db);
  const configResult = await loadConfig(root);
  if (configResult.isErr()) throw new Error('loadConfig failed');
  return {
    root,
    store,
    registry,
    config: configResult.value,
    progress,
    db,
  };
}

describe('createDaemonProjectRelay cache eviction and invalidation (TRA-1719)', () => {
  it('exposes DEFAULT_MAX_RELAY_TARGETS = 64', async () => {
    const { DEFAULT_MAX_RELAY_TARGETS } = await import('../../src/daemon/project-relay.js');
    expect(DEFAULT_MAX_RELAY_TARGETS).toBe(64);
  });

  it('invalidateProject(root) disposes the cached handle and forces next call to reopen', async () => {
    const { createDaemonProjectRelay } = await import('../../src/daemon/project-relay.js');
    const projA = await makeManagedProject(projectA);
    const liveMap = new Map<string, any>([[projectA, projA]]);

    const mockProjectManager = {
      getProject: vi.fn((r: string) => liveMap.get(r)),
      addProject: vi.fn(async (r: string) => liveMap.get(r)),
      touchActivity: vi.fn(),
    };
    const mockResourcePool = {
      getSharedDeps: vi.fn().mockReturnValue({}),
      acquire: vi.fn(),
      release: vi.fn(),
    };

    const relay = createDaemonProjectRelay(mockProjectManager as any, mockResourcePool as any);
    const handle1 = await relay.openProject(projectA);
    expect(handle1).not.toBeNull();

    // Cache hit
    const handleCached = await relay.openProject(projectA);
    expect(handleCached).toBe(handle1);

    // Spy on dispose
    const disposeSpy = vi.spyOn(handle1 as any, 'dispose');

    // Invalidate
    relay.invalidateProject(projectA);
    expect(disposeSpy).toHaveBeenCalled();

    // Opening again re-creates handle
    const handle2 = await relay.openProject(projectA);
    expect(handle2).not.toBeNull();
    expect(handle2).not.toBe(handle1);

    relay.dispose();
    projA.db.close();
  });

  it('invalidateProject(root) is idempotent and safe for unknown roots', async () => {
    const { createDaemonProjectRelay } = await import('../../src/daemon/project-relay.js');
    const mockProjectManager = {
      getProject: vi.fn(),
      addProject: vi.fn(),
      touchActivity: vi.fn(),
    };
    const mockResourcePool = {
      getSharedDeps: vi.fn().mockReturnValue({}),
      acquire: vi.fn(),
      release: vi.fn(),
    };
    const relay = createDaemonProjectRelay(mockProjectManager as any, mockResourcePool as any);
    expect(() => relay.invalidateProject('/unknown/root')).not.toThrow();
    relay.dispose();
  });

  it('evicts stale project first when capacity is exceeded', async () => {
    const { createDaemonProjectRelay } = await import('../../src/daemon/project-relay.js');
    const projA = await makeManagedProject(projectA);
    const projB = await makeManagedProject(projectB);
    const projC = await makeManagedProject(projectC);

    const liveMap = new Map<string, any>([
      [projectA, projA],
      [projectB, projB],
      [projectC, projC],
    ]);

    const mockProjectManager = {
      getProject: vi.fn((r: string) => liveMap.get(r)),
      addProject: vi.fn(async (r: string) => liveMap.get(r)),
      touchActivity: vi.fn(),
    };
    const mockResourcePool = {
      getSharedDeps: vi.fn().mockReturnValue({}),
      acquire: vi.fn(),
      release: vi.fn(),
    };

    // Capacity cap: 2 targets
    const relay = createDaemonProjectRelay(mockProjectManager as any, mockResourcePool as any, 2);

    // Open projectA, then projectB
    const handleA = await relay.openProject(projectA);
    const handleB = await relay.openProject(projectB);
    expect(handleA).not.toBeNull();
    expect(handleB).not.toBeNull();

    const disposeSpyA = vi.spyOn(handleA as any, 'dispose');
    const disposeSpyB = vi.spyOn(handleB as any, 'dispose');

    // Touch projectA so projectA is more recently accessed than projectB
    await relay.openProject(projectA);

    // Now simulate projectA becoming stale (unloaded / stopped)
    liveMap.delete(projectA);

    // Now open projectC. Even though projectA was accessed more recently than projectB,
    // projectA is STALE, so it must be evicted first!
    const handleC = await relay.openProject(projectC);
    expect(handleC).not.toBeNull();

    expect(disposeSpyA).toHaveBeenCalled();
    expect(disposeSpyB).not.toHaveBeenCalled();

    // Verify handleB is still in cache
    const handleBRecheck = await relay.openProject(projectB);
    expect(handleBRecheck).toBe(handleB);

    relay.dispose();
    projA.db.close();
    projB.db.close();
    projC.db.close();
  });

  it('evicts least recently accessed project (LRU) when all entries are live', async () => {
    const { createDaemonProjectRelay } = await import('../../src/daemon/project-relay.js');
    const projA = await makeManagedProject(projectA);
    const projB = await makeManagedProject(projectB);
    const projC = await makeManagedProject(projectC);

    const liveMap = new Map<string, any>([
      [projectA, projA],
      [projectB, projB],
      [projectC, projC],
    ]);

    const mockProjectManager = {
      getProject: vi.fn((r: string) => liveMap.get(r)),
      addProject: vi.fn(async (r: string) => liveMap.get(r)),
      touchActivity: vi.fn(),
    };
    const mockResourcePool = {
      getSharedDeps: vi.fn().mockReturnValue({}),
      acquire: vi.fn(),
      release: vi.fn(),
    };

    // Capacity cap: 2 targets
    const relay = createDaemonProjectRelay(mockProjectManager as any, mockResourcePool as any, 2);

    const handleA = await relay.openProject(projectA);
    const handleB = await relay.openProject(projectB);

    const disposeSpyA = vi.spyOn(handleA as any, 'dispose');
    const disposeSpyB = vi.spyOn(handleB as any, 'dispose');

    // Both are live. projectA was accessed first, then projectB.
    // Opening projectC must evict the least recently used: projectA.
    const handleC = await relay.openProject(projectC);
    expect(handleC).not.toBeNull();

    expect(disposeSpyA).toHaveBeenCalled();
    expect(disposeSpyB).not.toHaveBeenCalled();

    // projectB is still in cache
    const handleBRecheck = await relay.openProject(projectB);
    expect(handleBRecheck).toBe(handleB);

    relay.dispose();
    projA.db.close();
    projB.db.close();
    projC.db.close();
  });
});

describe('createLightweightProjectRelay cache eviction and invalidation (TRA-1719)', () => {
  it('invalidateProject(root) disposes handle and closes DB', async () => {
    const { registerProject, getProject } = await import('../../src/registry.js');
    const { initializeDatabase } = await import('../../src/db/schema.js');
    const { createLightweightProjectRelay } = await import('../../src/daemon/project-relay.js');

    registerProject(projectA);
    const entry = getProject(projectA);
    const preDb = initializeDatabase(entry!.dbPath);
    preDb.close();

    const relay = createLightweightProjectRelay();
    const handle1 = await relay.openProject(projectA);
    expect(handle1).not.toBeNull();

    // Cache hit
    const handleCached = await relay.openProject(projectA);
    expect(handleCached).toBe(handle1);

    const disposeSpy = vi.spyOn(handle1 as any, 'dispose');

    relay.invalidateProject(projectA);
    expect(disposeSpy).toHaveBeenCalled();

    // Reopen opens a fresh handle
    const handle2 = await relay.openProject(projectA);
    expect(handle2).not.toBeNull();
    expect(handle2).not.toBe(handle1);

    relay.dispose();
  });

  it('bounds cache size and evicts LRU handle', async () => {
    const { registerProject, getProject } = await import('../../src/registry.js');
    const { initializeDatabase } = await import('../../src/db/schema.js');
    const { createLightweightProjectRelay } = await import('../../src/daemon/project-relay.js');

    registerProject(projectA);
    registerProject(projectB);
    registerProject(projectC);

    const entryA = getProject(projectA);
    const dbA = initializeDatabase(entryA!.dbPath);
    dbA.close();

    const entryB = getProject(projectB);
    const dbB = initializeDatabase(entryB!.dbPath);
    dbB.close();

    const entryC = getProject(projectC);
    const dbC = initializeDatabase(entryC!.dbPath);
    dbC.close();

    const relay = createLightweightProjectRelay(2);
    const handleA = await relay.openProject(projectA);
    const handleB = await relay.openProject(projectB);

    const disposeSpyA = vi.spyOn(handleA as any, 'dispose');
    const disposeSpyB = vi.spyOn(handleB as any, 'dispose');

    // Opening projectC pushes past cap of 2 -> evicts oldest (A)
    const handleC = await relay.openProject(projectC);
    expect(handleC).not.toBeNull();

    expect(disposeSpyA).toHaveBeenCalled();
    expect(disposeSpyB).not.toHaveBeenCalled();

    relay.dispose();
  });
});
