/**
 * TRA-527: the drain for topology rows earlier versions wrote for one-shot
 * agent-run checkouts. They have no registry row, so no removeProject path can
 * ever reach them — without this sweep they stay in the global topology DB for
 * good and every scoped query fans out over them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpHome: string;

/** Register `root` as a subproject in the global topology DB. */
async function addSubproject(root: string): Promise<void> {
  const { TOPOLOGY_DB_PATH, ensureGlobalDirs } = await import('../../global.js');
  const { TopologyStore } = await import('../../topology/topology-db.js');
  ensureGlobalDirs();
  const store = new TopologyStore(TOPOLOGY_DB_PATH);
  try {
    store.upsertSubproject({ name: path.basename(root), repoRoot: root, projectRoot: root });
  } finally {
    store.close();
  }
}

async function subprojectRoots(): Promise<string[]> {
  const { TOPOLOGY_DB_PATH } = await import('../../global.js');
  const { TopologyStore } = await import('../../topology/topology-db.js');
  const store = new TopologyStore(TOPOLOGY_DB_PATH);
  try {
    return store.getAllSubprojects().map((s) => s.repo_root);
  } finally {
    store.close();
  }
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-topo-sweep-'));
  vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('sweepEphemeralTopology (TRA-527)', () => {
  it('drops one-shot workdir rows and keeps real projects', async () => {
    const workdir = path.join(tmpHome, 'multica_workspaces_x.ai', 'ws-1', 'run-1', 'workdir');
    const checkout = path.join(workdir, 'trace-mcp');
    const real = path.join(tmpHome, 'real-project');
    for (const r of [workdir, checkout, real]) await addSubproject(r);

    const { sweepEphemeralTopology } = await import('../project-artifacts.js');

    expect((await sweepEphemeralTopology()).sort()).toEqual([checkout, workdir].sort());
    expect(await subprojectRoots()).toEqual([real]);
    expect(await sweepEphemeralTopology()).toEqual([]); // idempotent
  });

  it('is a no-op when no topology DB exists', async () => {
    const { sweepEphemeralTopology } = await import('../project-artifacts.js');
    expect(await sweepEphemeralTopology()).toEqual([]);
  });
});
