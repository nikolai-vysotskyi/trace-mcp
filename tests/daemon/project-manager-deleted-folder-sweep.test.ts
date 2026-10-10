import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectManager } from '../../src/daemon/project-manager.js';
import { getDbPath, INDEX_DIR } from '../../src/global.js';
import { setupProject } from '../../src/project-setup.js';
import { listProjects, loadRegistry, registerProject } from '../../src/registry.js';

describe('TRA-2313: Deleted folder eviction and orphan DB cleanup', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tra-2313-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('setupProject rejects nonexistent directory without saving to registry or creating DB', () => {
    const nonexistent = path.join(tempRoot, 'does-not-exist');
    expect(fs.existsSync(nonexistent)).toBe(false);

    expect(() => setupProject(nonexistent)).toThrow(/Project directory does not exist/);

    const registered = listProjects().map((p) => p.root);
    expect(registered).not.toContain(path.resolve(nonexistent));

    const dbPath = getDbPath(nonexistent);
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('addProject rejects nonexistent directory', async () => {
    const nonexistent = path.join(tempRoot, 'does-not-exist');
    const pm = new ProjectManager();

    await expect(pm.addProject(nonexistent)).rejects.toThrow(/Project directory does not exist/);

    const registered = listProjects().map((p) => p.root);
    expect(registered).not.toContain(path.resolve(nonexistent));
  });

  it('evictDeletedProjects evicts missing project, unregisters it, and deletes its DB file', async () => {
    const projDir = path.join(tempRoot, 'my-project');
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, 'index.ts'), 'export const hello = "world";');

    // Register and set up project
    setupProject(projDir);
    const dbPath = getDbPath(projDir);
    // Create DB file to simulate indexed DB
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'fake-db-content');
    fs.writeFileSync(`${dbPath}-wal`, 'fake-wal');
    fs.writeFileSync(`${dbPath}-shm`, 'fake-shm');

    expect(listProjects().some((p) => p.root === projDir)).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    // Now simulate deleting the project folder on disk
    fs.rmSync(projDir, { recursive: true, force: true });
    expect(fs.existsSync(projDir)).toBe(false);
    expect(fs.existsSync(tempRoot)).toBe(true); // parent still exists

    const pm = new ProjectManager();
    const evicted = await pm.evictDeletedProjects();

    expect(evicted).toContain(projDir);
    expect(listProjects().some((p) => p.root === projDir)).toBe(false);
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);

    // Idempotent: running again does nothing and returns empty
    const secondEvicted = await pm.evictDeletedProjects();
    expect(secondEvicted).toEqual([]);
  });

  it('preserves registered projects on unmounted volume (parent dir also missing)', async () => {
    const unmountedVol = path.join(tempRoot, 'unmounted-vol');
    const projDir = path.join(unmountedVol, 'project-a');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'index.ts'), 'export const x = 1;');

    setupProject(projDir);
    const dbPath = getDbPath(projDir);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'fake-db');

    // Delete the entire volume directory (parent is missing too)
    fs.rmSync(unmountedVol, { recursive: true, force: true });
    expect(fs.existsSync(projDir)).toBe(false);
    expect(fs.existsSync(unmountedVol)).toBe(false);

    const pm = new ProjectManager();
    const evicted = await pm.evictDeletedProjects();

    expect(evicted).not.toContain(projDir);
    expect(listProjects().some((p) => p.root === projDir)).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it('handles concurrent addition and deletion of multiple projects cleanly', async () => {
    const projects: { dir: string; dbPath: string; shouldKeep: boolean }[] = [];

    // Create 6 projects
    for (let i = 0; i < 6; i++) {
      const dir = path.join(tempRoot, `proj-${i}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'index.ts'), `export const i = ${i};`);
      setupProject(dir);
      const dbPath = getDbPath(dir);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, `fake-db-${i}`);
      projects.push({ dir, dbPath, shouldKeep: i % 2 === 0 });
    }

    // Concurrently delete half of them
    const deletePromises = projects
      .filter((p) => !p.shouldKeep)
      .map(async (p) => {
        fs.rmSync(p.dir, { recursive: true, force: true });
      });
    await Promise.all(deletePromises);

    const pm = new ProjectManager();
    const evicted = await pm.evictDeletedProjects();

    const expectedEvicted = projects.filter((p) => !p.shouldKeep).map((p) => p.dir);
    expect(evicted.sort()).toEqual(expectedEvicted.sort());

    for (const p of projects) {
      if (p.shouldKeep) {
        expect(listProjects().some((entry) => entry.root === p.dir)).toBe(true);
        expect(fs.existsSync(p.dbPath)).toBe(true);
      } else {
        expect(listProjects().some((entry) => entry.root === p.dir)).toBe(false);
        expect(fs.existsSync(p.dbPath)).toBe(false);
      }
    }
  });

  it('evictDeletedProjects stops and evicts resident projects from memory', async () => {
    const projDir = path.join(tempRoot, 'resident-proj');
    fs.mkdirSync(projDir);
    fs.writeFileSync(path.join(projDir, 'index.ts'), 'export const a = 1;');

    const pm = new ProjectManager();
    // Setup and register
    setupProject(projDir);
    const dbPath = getDbPath(projDir);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'fake-db');

    // Add fake project directly to pm.projects to simulate resident project
    const fakeManaged: any = {
      root: projDir,
      config: {},
      db: { close: vi.fn() },
      store: {},
      registry: {},
      progress: {},
      pipeline: { dispose: vi.fn(async () => undefined) },
      watcher: {
        stop: vi.fn(),
        unsubscribe: vi.fn(async () => undefined),
        drain: vi.fn(async () => undefined),
      },
      server: { close: vi.fn() },
      serverHandle: { dispose: vi.fn(async () => undefined) },
      status: 'ready',
      lastAccessedAt: Date.now(),
    };
    (pm as any).projects.set(projDir, fakeManaged);

    expect((pm as any).projects.has(projDir)).toBe(true);

    // Delete folder from disk
    fs.rmSync(projDir, { recursive: true, force: true });

    // Evict
    const evicted = await pm.evictDeletedProjects();

    expect(evicted).toContain(projDir);
    expect((pm as any).projects.has(projDir)).toBe(false);
    expect(fakeManaged.watcher.unsubscribe).toHaveBeenCalled();
    expect(fakeManaged.db.close).toHaveBeenCalled();
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('loadAllRegistered evicts deleted projects and removes their DBs on boot', async () => {
    const liveDir = path.join(tempRoot, 'live-proj');
    const deletedDir = path.join(tempRoot, 'deleted-proj');
    fs.mkdirSync(liveDir);
    fs.mkdirSync(deletedDir);
    fs.writeFileSync(path.join(liveDir, 'index.ts'), 'export const live = true;');
    fs.writeFileSync(path.join(deletedDir, 'index.ts'), 'export const deleted = true;');

    setupProject(liveDir);
    setupProject(deletedDir);

    const liveDb = getDbPath(liveDir);
    const deletedDb = getDbPath(deletedDir);
    fs.mkdirSync(path.dirname(liveDb), { recursive: true });
    fs.writeFileSync(liveDb, 'live-db');
    fs.writeFileSync(deletedDb, 'deleted-db');

    // Delete deletedDir
    fs.rmSync(deletedDir, { recursive: true, force: true });

    const pm = new ProjectManager();
    // Stub addProject so it doesn't spin up full daemon indexing
    const addSpy = vi.spyOn(pm, 'addProject').mockImplementation(async () => ({}) as any);

    await pm.loadAllRegistered();

    expect(listProjects().some((p) => p.root === deletedDir)).toBe(false);
    expect(listProjects().some((p) => p.root === liveDir)).toBe(true);
    expect(fs.existsSync(deletedDb)).toBe(false);
    expect(fs.existsSync(liveDb)).toBe(true);
    expect(addSpy).toHaveBeenCalledWith(liveDir);
    expect(addSpy).not.toHaveBeenCalledWith(deletedDir);
  });

  it('startIdleUnloadSweep periodically evicts deleted projects and calls onUnloaded', async () => {
    vi.useFakeTimers();
    try {
      const projDir = path.join(tempRoot, 'periodic-sweep-proj');
      fs.mkdirSync(projDir);
      fs.writeFileSync(path.join(projDir, 'index.ts'), 'export const z = 9;');

      setupProject(projDir);
      const dbPath = getDbPath(projDir);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, 'fake-db');

      const pm = new ProjectManager();
      const onUnloaded = vi.fn();

      pm.startIdleUnloadSweep(30 * 60_000, {
        intervalMs: 10_000,
        evictDeleted: true,
        onUnloaded,
      });

      // Delete the directory
      fs.rmSync(projDir, { recursive: true, force: true });

      // Advance timer by one interval
      await vi.advanceTimersByTimeAsync(10_000);

      expect(onUnloaded).toHaveBeenCalledWith([projDir]);
      expect(listProjects().some((p) => p.root === projDir)).toBe(false);
      expect(fs.existsSync(dbPath)).toBe(false);

      pm.stopIdleUnloadSweep();
    } finally {
      vi.useRealTimers();
    }
  });

  it('evictDeletedProjects evicts unpersisted resident projects (persist: false) when directory is deleted', async () => {
    const unpersistedDir = path.join(tempRoot, 'unpersisted-resident-proj');
    fs.mkdirSync(unpersistedDir);
    fs.writeFileSync(path.join(unpersistedDir, 'index.ts'), 'export const u = 42;');

    const pm = new ProjectManager();

    // Verify it is NOT in registry.json
    expect(listProjects().some((p) => p.root === unpersistedDir)).toBe(false);

    // Simulate resident project added with persist: false (in memory only, no registry entry)
    const fakeManaged: any = {
      root: unpersistedDir,
      config: {},
      db: { close: vi.fn() },
      store: {},
      registry: {},
      progress: {},
      pipeline: { dispose: vi.fn(async () => undefined) },
      watcher: {
        stop: vi.fn(),
        unsubscribe: vi.fn(async () => undefined),
        drain: vi.fn(async () => undefined),
      },
      server: { close: vi.fn() },
      serverHandle: { dispose: vi.fn(async () => undefined) },
      status: 'ready',
      lastAccessedAt: Date.now(),
    };
    (pm as any).projects.set(unpersistedDir, fakeManaged);

    expect((pm as any).projects.has(unpersistedDir)).toBe(true);

    // Delete folder from disk
    fs.rmSync(unpersistedDir, { recursive: true, force: true });
    expect(fs.existsSync(unpersistedDir)).toBe(false);

    // Run eviction
    const evicted = await pm.evictDeletedProjects();

    expect(evicted).toContain(unpersistedDir);
    expect((pm as any).projects.has(unpersistedDir)).toBe(false);
    expect(fakeManaged.watcher.unsubscribe).toHaveBeenCalled();
    expect(fakeManaged.db.close).toHaveBeenCalled();
  });
});
