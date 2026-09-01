import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TopologyStore } from '../../src/topology/topology-db.js';

describe('TopologyStore stale pruning (TRA-595)', () => {
  let store: TopologyStore;
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topo-prune-test-'));
    dbPath = path.join(tmpDir, 'topology.db');
    store = new TopologyStore(dbPath);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects and prunes services and subprojects whose folders no longer exist', () => {
    const liveDir = path.join(tmpDir, 'live-svc');
    const deadDir = path.join(tmpDir, 'dead-svc');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.mkdirSync(deadDir, { recursive: true });

    const liveSvcId = store.upsertService({
      name: 'live-svc',
      repoRoot: liveDir,
      serviceType: 'api',
      detectionSource: 'docker',
      dbPath: path.join(liveDir, 'idx.db'),
    });

    const deadSvcId = store.upsertService({
      name: 'dead-svc',
      repoRoot: deadDir,
      serviceType: 'api',
      detectionSource: 'docker',
      dbPath: path.join(deadDir, 'idx.db'),
    });

    const liveSubId = store.upsertSubproject({
      name: 'live-sub',
      repoRoot: liveDir,
      projectRoot: liveDir,
      dbPath: path.join(liveDir, 'idx.db'),
    });

    const deadSubId = store.upsertSubproject({
      name: 'dead-sub',
      repoRoot: deadDir,
      projectRoot: deadDir,
      dbPath: path.join(deadDir, 'idx.db'),
    });

    const contractId = store.insertContract(deadSvcId, {
      contractType: 'openapi',
      specPath: 'openapi.json',
      version: '1.0.0',
      parsedSpec: '{}',
    });

    // Create client calls referencing endpoints and repos
    store.insertEndpoints(contractId, deadSvcId, [
      {
        path: '/api/v1/dead',
        method: 'GET',
        handlerFunction: 'getDead',
        filePath: 'src/routes.ts',
      },
    ]);
    const endpoints = store.getEndpointsByService(deadSvcId);
    expect(endpoints).toHaveLength(1);

    store.insertClientCalls([
      {
        sourceRepoId: liveSubId,
        targetRepoId: deadSubId,
        matchedEndpointId: endpoints[0].id,
        filePath: 'src/caller.ts',
        callType: 'http',
        urlPattern: '/api/v1/dead',
      },
    ]);

    // Verify initial health check reports 0 stale
    expect(store.findStale().staleServices).toHaveLength(0);
    expect(store.findStale().staleSubprojects).toHaveLength(0);

    // Now delete deadDir from disk
    fs.rmSync(deadDir, { recursive: true, force: true });

    // Check findStale
    const stale = store.findStale();
    expect(stale.staleServices.map((s) => s.name)).toEqual(['dead-svc']);
    expect(stale.staleSubprojects.map((s) => s.name)).toEqual(['dead-sub']);

    // Prune stale entries
    const pruneResult = store.pruneStale();
    expect(pruneResult.services).toBe(1);
    expect(pruneResult.subprojects).toBe(1);
    expect(pruneResult.removedServices.map((s) => s.name)).toEqual(['dead-svc']);
    expect(pruneResult.removedSubprojects.map((s) => s.name)).toEqual(['dead-sub']);

    // Verify dead service and subproject are gone, and live service and subproject survive
    expect(store.getService('dead-svc')).toBeUndefined();
    expect(store.getService('live-svc')).toBeDefined();
    expect(store.getAllSubprojects().map((s) => s.name)).toEqual(['live-sub']);

    // Verify client calls still exist but foreign keys are detached
    const clientCalls = store.getClientCallsByRepo(liveSubId);
    expect(clientCalls).toHaveLength(1);
    expect(clientCalls[0].target_repo_id).toBeNull();
    expect(clientCalls[0].matched_endpoint_id).toBeNull();
  });

  it('is a no-op when topology has no stale roots', () => {
    const liveDir = path.join(tmpDir, 'live-svc');
    fs.mkdirSync(liveDir, { recursive: true });

    store.upsertService({
      name: 'live-svc',
      repoRoot: liveDir,
      serviceType: 'api',
      detectionSource: 'docker',
      dbPath: path.join(liveDir, 'idx.db'),
    });

    const res = store.pruneStale();
    expect(res.services).toBe(0);
    expect(res.subprojects).toBe(0);
    expect(res.removedServices).toEqual([]);
    expect(res.removedSubprojects).toEqual([]);
  });
});
