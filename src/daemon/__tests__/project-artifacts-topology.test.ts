/**
 * TRA-2778: removeProjectArtifacts must drop topology rows for the removed project root
 * without failing or throwing MODULE_NOT_FOUND.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('removeProjectArtifacts — topology rows (TRA-2778)', () => {
  let tmpHome: string;
  let tmpProjects: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-artifacts-topology-home-'));
    tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-artifacts-topology-projects-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProjects, { recursive: true, force: true });
  });

  it('drops topology subprojects and services for the target root and leaves other roots intact', async () => {
    const rootA = path.join(tmpProjects, 'project-a');
    const rootB = path.join(tmpProjects, 'project-b');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });

    const { TOPOLOGY_DB_PATH, ensureGlobalDirs } = await import('../../global.js');
    const { TopologyStore } = await import('../../topology/topology-db.js');
    ensureGlobalDirs();

    const store = new TopologyStore(TOPOLOGY_DB_PATH);
    try {
      store.upsertSubproject({
        name: 'service-a',
        repoRoot: rootA,
        projectRoot: rootA,
      });
      store.upsertSubproject({
        name: 'service-b',
        repoRoot: rootB,
        projectRoot: rootB,
      });
      store.upsertService({
        name: 'service-a',
        repoRoot: rootA,
        dbPath: path.join(rootA, 'index.db'),
        serviceType: 'backend',
      });
      store.upsertService({
        name: 'service-b',
        repoRoot: rootB,
        dbPath: path.join(rootB, 'index.db'),
        serviceType: 'backend',
      });
    } finally {
      store.close();
    }

    const { removeProjectArtifacts } = await import('../project-artifacts.js');
    const result = removeProjectArtifacts(rootA);

    expect(result.topology.subprojects).toBe(1);
    expect(result.topology.services).toBe(1);
    expect(result.failures.filter((f) => f.tier === 'topology')).toEqual([]);

    // Verify topology.db state
    const verifyStore = new TopologyStore(TOPOLOGY_DB_PATH);
    try {
      const remainingSubs = verifyStore.getAllSubprojects().map((s) => s.repo_root);
      expect(remainingSubs).toContain(rootB);
      expect(remainingSubs).not.toContain(rootA);

      const remainingServices = verifyStore.getAllServices().map((s) => s.repo_root);
      expect(remainingServices).toContain(rootB);
      expect(remainingServices).not.toContain(rootA);
    } finally {
      verifyStore.close();
    }
  });

  it('handles missing topology.db cleanly without errors', async () => {
    const root = path.join(tmpProjects, 'project-a');
    const { removeProjectArtifacts } = await import('../project-artifacts.js');
    const result = removeProjectArtifacts(root);

    expect(result.topology).toEqual({ subprojects: 0, services: 0 });
    expect(result.failures.filter((f) => f.tier === 'topology')).toEqual([]);
  });

  it('drops topology rows when queried via canonical root but stored under symlink alias', async () => {
    const targetDir = path.join(tmpProjects, 'target-project');
    const linkDir = path.join(tmpProjects, 'link-project');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.symlinkSync(targetDir, linkDir, 'junction');

    const { TOPOLOGY_DB_PATH, ensureGlobalDirs } = await import('../../global.js');
    const { TopologyStore } = await import('../../topology/topology-db.js');
    ensureGlobalDirs();

    const store = new TopologyStore(TOPOLOGY_DB_PATH);
    try {
      store.upsertSubproject({
        name: 'service-symlink',
        repoRoot: linkDir,
        projectRoot: linkDir,
      });
      store.upsertService({
        name: 'service-symlink',
        repoRoot: linkDir,
        dbPath: path.join(linkDir, 'index.db'),
        serviceType: 'backend',
      });
    } finally {
      store.close();
    }

    const { removeProjectArtifacts } = await import('../project-artifacts.js');
    // Remove using targetDir (canonical / realpath)
    const result = removeProjectArtifacts(targetDir);

    expect(result.topology.subprojects).toBe(1);
    expect(result.topology.services).toBe(1);
    expect(result.failures.filter((f) => f.tier === 'topology')).toEqual([]);

    const verifyStore = new TopologyStore(TOPOLOGY_DB_PATH);
    try {
      const remainingSubs = verifyStore.getAllSubprojects().map((s) => s.repo_root);
      expect(remainingSubs).not.toContain(linkDir);
      expect(remainingSubs).not.toContain(targetDir);

      const remainingServices = verifyStore.getAllServices().map((s) => s.repo_root);
      expect(remainingServices).not.toContain(linkDir);
      expect(remainingServices).not.toContain(targetDir);
    } finally {
      verifyStore.close();
    }
  });

  it('preserves cross-repo subproject links in other projects when target project is removed', async () => {
    const rootA = path.join(tmpProjects, 'project-a');
    const rootB = path.join(tmpProjects, 'project-b');
    const linkA = path.join(tmpProjects, 'link-a');
    fs.mkdirSync(rootA, { recursive: true });
    fs.mkdirSync(rootB, { recursive: true });
    fs.symlinkSync(rootA, linkA, 'junction');

    const { TOPOLOGY_DB_PATH, ensureGlobalDirs } = await import('../../global.js');
    const { TopologyStore } = await import('../../topology/topology-db.js');
    ensureGlobalDirs();

    const store = new TopologyStore(TOPOLOGY_DB_PATH);
    try {
      // Project A self-registered (under symlink)
      store.upsertSubproject({
        name: 'service-a',
        repoRoot: linkA,
        projectRoot: linkA,
      });
      store.upsertService({
        name: 'service-a',
        repoRoot: linkA,
        dbPath: path.join(linkA, 'index.db'),
        serviceType: 'backend',
      });

      // Project B self-registered
      store.upsertSubproject({
        name: 'service-b',
        repoRoot: rootB,
        projectRoot: rootB,
      });
      store.upsertService({
        name: 'service-b',
        repoRoot: rootB,
        dbPath: path.join(rootB, 'index.db'),
        serviceType: 'backend',
      });

      // Project B registers Project A as a cross-repo dependency
      store.upsertSubproject({
        name: 'dep-a-in-b',
        repoRoot: linkA,
        projectRoot: rootB,
      });
    } finally {
      store.close();
    }

    const { removeProjectArtifacts } = await import('../project-artifacts.js');
    // Remove Project A via canonical root
    const result = removeProjectArtifacts(rootA);

    expect(result.topology.subprojects).toBe(1);
    expect(result.topology.services).toBe(1);
    expect(result.failures.filter((f) => f.tier === 'topology')).toEqual([]);

    const verifyStore = new TopologyStore(TOPOLOGY_DB_PATH);
    try {
      // Subprojects of Project B MUST be preserved intact, including the cross-repo link to A
      const bSubs = verifyStore.getSubprojectsByProject(rootB);
      expect(bSubs.length).toBe(2);
      const bRepoRoots = bSubs.map((s) => s.repo_root);
      expect(bRepoRoots).toContain(rootB);
      expect(bRepoRoots).toContain(linkA);

      // Project A's own subprojects must be gone
      const aSubs = verifyStore.getSubprojectsByProject(rootA);
      expect(aSubs).toEqual([]);
      const aLinkSubs = verifyStore.getSubprojectsByProject(linkA);
      expect(aLinkSubs).toEqual([]);

      // Project A service gone, Project B service intact
      const remainingServices = verifyStore.getAllServices().map((s) => s.repo_root);
      expect(remainingServices).toContain(rootB);
      expect(remainingServices).not.toContain(rootA);
      expect(remainingServices).not.toContain(linkA);
    } finally {
      verifyStore.close();
    }
  });
});
