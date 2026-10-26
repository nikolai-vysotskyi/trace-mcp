import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('consolidated service index paths (TRA-2713)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-consolidated-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', dataDir);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('distinguishes a stale service pointer from an unavailable index and heals it on sync', async () => {
    const { registerProject } = await import('../../src/registry.js');
    const { TopologyStore } = await import('../../src/topology/topology-db.js');
    const { SubprojectManager } = await import('../../src/subproject/manager.js');
    const { getDbPath } = await import('../../src/global.js');
    const doctor = await import('../../src/cli/doctor.js');
    const prune = await import('../../src/cli/prune.js');

    const parentRoot = path.join(dataDir, 'parent');
    const childRoot = path.join(dataDir, 'child');
    fs.mkdirSync(parentRoot);
    fs.mkdirSync(childRoot);
    const parent = registerProject(parentRoot, { type: 'multi-root', children: [childRoot] });
    fs.mkdirSync(path.dirname(parent.dbPath), { recursive: true });
    new Database(parent.dbPath).close();

    const topo = new TopologyStore(path.join(dataDir, 'topology.db'));
    try {
      topo.upsertSubproject({
        name: 'child',
        repoRoot: childRoot,
        projectRoot: parentRoot,
        dbPath: parent.dbPath,
      });
      topo.upsertService({
        name: 'child',
        repoRoot: childRoot,
        dbPath: getDbPath(childRoot),
      });

      const before = topo.findStale();
      expect(before.missingDbServices).toEqual([]);
      expect(before.staleDbPathServices).toEqual([
        expect.objectContaining({
          name: 'child',
          db_path: getDbPath(childRoot),
          resolved_db_path: parent.dbPath,
        }),
      ]);
      expect(doctor.diagnoseTopology().staleDbPathServices).toEqual([
        expect.objectContaining({ name: 'child', resolvedDbPath: parent.dbPath }),
      ]);
      expect(prune.scanOrPruneTopology(false).staleDbPathServices).toHaveLength(1);

      await new SubprojectManager(topo).sync();
      expect(topo.getService('child')?.db_path).toBe(parent.dbPath);
      expect(topo.findStale().staleDbPathServices).toEqual([]);
      expect(doctor.diagnoseTopology().staleDbPathServices).toEqual([]);
    } finally {
      topo.close();
    }
  });
});
