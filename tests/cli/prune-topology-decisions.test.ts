import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopologyStore } from '../../src/topology/topology-db.js';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('trace-mcp prune topology & decisions integration (TRA-595)', () => {
  let tmpHome: string;
  let pruneModule: typeof import('../../src/cli/prune.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-prune-int-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    pruneModule = await import('../../src/cli/prune.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('scans and prunes stale topology and decisions', () => {
    const topoDbPath = path.join(tmpHome, 'topology.db');
    const decisionsDbPath = path.join(tmpHome, 'decisions.db');
    const deadDir = path.join(tmpHome, 'dead-folder');
    fs.mkdirSync(deadDir, { recursive: true });

    // Seed topology
    const topo = new TopologyStore(topoDbPath);
    topo.upsertService({
      name: 'dead-svc',
      repoRoot: deadDir,
      serviceType: 'api',
      detectionSource: 'docker',
      dbPath: path.join(deadDir, 'idx.db'),
    });
    topo.close();

    // Seed decisions
    const dec = new DecisionStore(decisionsDbPath);
    dec.addDecision({
      title: 'Dead tech choice',
      content: 'Dead choice content',
      type: 'tech_choice',
      project_root: deadDir,
    });
    dec.close();

    // Remove folder
    fs.rmSync(deadDir, { recursive: true, force: true });

    // Dry-run scan
    const dryTopo = pruneModule.scanOrPruneTopology(false);
    expect(dryTopo.staleServices.map((s) => s.name)).toEqual(['dead-svc']);
    expect(dryTopo.removedServices).toBe(0);

    const dryDec = pruneModule.scanOrPruneDecisions(false);
    expect(dryDec.staleRoots).toEqual([deadDir]);
    expect(dryDec.staleDecisionsCount).toBe(1);
    expect(dryDec.removedDecisions).toBe(0);

    // Apply prune
    const applyTopo = pruneModule.scanOrPruneTopology(true);
    expect(applyTopo.removedServices).toBe(1);

    const applyDec = pruneModule.scanOrPruneDecisions(true);
    expect(applyDec.removedDecisions).toBe(1);
    expect(applyDec.staleRoots).toEqual([deadDir]);

    // Subsequent scan is clean
    const cleanTopo = pruneModule.scanOrPruneTopology(false);
    expect(cleanTopo.staleServices).toHaveLength(0);

    const cleanDec = pruneModule.scanOrPruneDecisions(false);
    expect(cleanDec.staleRoots).toHaveLength(0);
  });
});
