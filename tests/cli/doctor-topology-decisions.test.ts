import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopologyStore } from '../../src/topology/topology-db.js';
import { DecisionStore } from '../../src/memory/decision-store.js';

describe('doctor topology and decisions hygiene (TRA-595)', () => {
  let tmpHome: string;
  let doctor: typeof import('../../src/cli/doctor.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-doc-hygiene-'));
    vi.stubEnv('TRACE_MCP_DATA_DIR', tmpHome);
    vi.resetModules();
    doctor = await import('../../src/cli/doctor.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('diagnoses and fixes stale topology entries and orphaned decisions', () => {
    const topoDbPath = path.join(tmpHome, 'topology.db');
    const decisionsDbPath = path.join(tmpHome, 'decisions.db');
    const deadDir = path.join(tmpHome, 'dead-app');
    fs.mkdirSync(deadDir, { recursive: true });

    // Seed topology
    const topo = new TopologyStore(topoDbPath);
    topo.upsertService({
      name: 'dead-service',
      repoRoot: deadDir,
      serviceType: 'api',
      detectionSource: 'docker',
      dbPath: path.join(deadDir, 'idx.db'),
    });
    topo.upsertSubproject({
      name: 'dead-sub',
      repoRoot: deadDir,
      projectRoot: deadDir,
      dbPath: path.join(deadDir, 'idx.db'),
    });
    topo.close();

    // Seed decisions
    const dec = new DecisionStore(decisionsDbPath);
    dec.addDecision({
      title: 'Dead decision title',
      content: 'Dead content',
      type: 'tech_choice',
      project_root: deadDir,
    });
    dec.close();

    // Remove dead directory
    fs.rmSync(deadDir, { recursive: true, force: true });

    // Diagnose
    const topoReport = doctor.diagnoseTopology();
    expect(topoReport.topologyExists).toBe(true);
    expect(topoReport.staleCount).toBe(2);
    expect(topoReport.staleServices.map((s) => s.name)).toEqual(['dead-service']);
    expect(topoReport.staleSubprojects.map((s) => s.name)).toEqual(['dead-sub']);

    const decReport = doctor.diagnoseDecisions();
    expect(decReport.decisionsExists).toBe(true);
    expect(decReport.staleRoots).toEqual([deadDir]);
    expect(decReport.staleDecisionsCount).toBe(1);

    // Dry-run fix
    const topoDryFix = doctor.fixTopologyIssues(topoReport, { dryRun: true });
    expect(topoDryFix.removedServices).toEqual(['dead-service']);
    expect(topoDryFix.removedSubprojects).toEqual(['dead-sub']);

    const decDryFix = doctor.fixDecisionsIssues(decReport, { dryRun: true });
    expect(decDryFix.removedRoots).toEqual([deadDir]);
    expect(decDryFix.removedDecisions).toBe(1);

    // Actual fix
    const topoFix = doctor.fixTopologyIssues(topoReport, { dryRun: false });
    expect(topoFix.removedServices).toEqual(['dead-service']);
    expect(topoFix.removedSubprojects).toEqual(['dead-sub']);

    const decFix = doctor.fixDecisionsIssues(decReport, { dryRun: false });
    expect(decFix.removedRoots).toEqual([deadDir]);
    expect(decFix.removedDecisions).toBe(1);

    // Re-diagnose confirms clean state
    const cleanTopo = doctor.diagnoseTopology();
    expect(cleanTopo.staleCount).toBe(0);

    const cleanDec = doctor.diagnoseDecisions();
    expect(cleanDec.staleRoots).toHaveLength(0);
    expect(cleanDec.staleDecisionsCount).toBe(0);
  });
});
