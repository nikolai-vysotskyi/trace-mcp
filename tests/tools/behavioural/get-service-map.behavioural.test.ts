/**
 * Behavioural coverage for `getServiceMap()`. Seeds a TopologyStore with
 * services, contracts, endpoints, events, and cross-service edges, then
 * verifies:
 *   - empty topology returns services: [], edges: [], zero stats
 *   - seeded topology lists both services + the cross-service edge
 *   - endpoint_count / event_count reflect per-service totals
 *   - each service entry has the expected shape
 *   - stats reflect totals across the topology
 *
 * NOTE: getServiceMap() also calls ensureTopologyBuilt() which auto-detects
 * services from the project root. We pass a tmp directory with no service
 * markers so detection is a no-op and only the seeded services appear.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServiceMap } from '../../../src/tools/project/topology.js';
import { TopologyStore } from '../../../src/topology/topology-db.js';

interface Fixture {
  store: TopologyStore;
  dbPath: string;
  projectRoot: string;
}

function makeStore(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-map-'));
  const dbPath = path.join(tmpDir, 'topology.db');
  const projectRoot = path.join(tmpDir, 'workspace');
  fs.mkdirSync(projectRoot, { recursive: true });
  return { store: new TopologyStore(dbPath), dbPath, projectRoot };
}

function seedTwoServices(ctx: Fixture): { svcAId: number; svcBId: number } {
  // service-a: 2 endpoints + 1 publish event.
  const svcAId = ctx.store.upsertService({
    name: 'service-a',
    repoRoot: '/repos/service-a',
    dbPath: '/fake/a.db',
    serviceType: 'api',
    detectionSource: 'test',
  });
  const contractAId = ctx.store.insertContract(svcAId, {
    contractType: 'openapi',
    specPath: '/repos/service-a/openapi.yaml',
    parsedSpec: '{}',
  });
  ctx.store.insertEndpoints(contractAId, svcAId, [
    { method: 'GET', path: '/users' },
    { method: 'POST', path: '/users' },
  ]);
  ctx.store.insertEventChannels(contractAId, svcAId, [
    { channelName: 'user.created', direction: 'publish' },
  ]);

  // service-b: no contracts, no endpoints, subscribes to user.created.
  const svcBId = ctx.store.upsertService({
    name: 'service-b',
    repoRoot: '/repos/service-b',
    dbPath: '/fake/b.db',
    serviceType: 'worker',
    detectionSource: 'test',
  });
  ctx.store.insertEventChannels(null, svcBId, [
    { channelName: 'user.created', direction: 'subscribe' },
  ]);

  // Cross-service edge: service-b -> service-a (api_call)
  ctx.store.insertCrossServiceEdge({
    sourceServiceId: svcBId,
    targetServiceId: svcAId,
    edgeType: 'api_call',
    sourceRef: 'src/worker.ts',
    targetRef: 'GET /users',
    confidence: 0.85,
  });

  return { svcAId, svcBId };
}

describe('getServiceMap() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = makeStore();
  });

  afterEach(() => {
    ctx.store.close();
    fs.rmSync(path.dirname(ctx.dbPath), { recursive: true, force: true });
  });

  it('topology with one bare service returns it + no edges + zero contract stats', () => {
    // Seed one minimal service so ensureTopologyBuilt() skips workspace auto-detect.
    ctx.store.upsertService({
      name: 'solo-svc',
      repoRoot: '/repos/solo',
      dbPath: '/fake/solo.db',
      serviceType: 'api',
      detectionSource: 'test',
    });

    const result = getServiceMap(ctx.store, ctx.projectRoot, []);
    expect(result.isOk()).toBe(true);
    const map = result._unsafeUnwrap();
    expect(map.services).toHaveLength(1);
    expect(map.services[0].name).toBe('solo-svc');
    expect(map.services[0].endpoint_count).toBe(0);
    expect(map.services[0].event_count).toBe(0);
    expect(map.edges).toEqual([]);
    expect(map.stats.services).toBe(1);
    expect(map.stats.contracts).toBe(0);
    expect(map.stats.endpoints).toBe(0);
    expect(map.stats.events).toBe(0);
    expect(map.stats.crossEdges).toBe(0);
  });

  it('seeded topology lists both services + the cross-service edge', () => {
    seedTwoServices(ctx);
    const map = getServiceMap(ctx.store, ctx.projectRoot, [])._unsafeUnwrap();

    const names = map.services.map((s) => s.name).sort();
    expect(names).toEqual(['service-a', 'service-b']);

    expect(map.edges).toHaveLength(1);
    expect(map.edges[0]).toMatchObject({
      source: 'service-b',
      target: 'service-a',
      edge_type: 'api_call',
    });
    expect(map.edges[0].confidence).toBeCloseTo(0.85);
  });

  it('endpoint_count / event_count reflect per-service totals', () => {
    seedTwoServices(ctx);
    const map = getServiceMap(ctx.store, ctx.projectRoot, [])._unsafeUnwrap();

    const a = map.services.find((s) => s.name === 'service-a')!;
    expect(a.endpoint_count).toBe(2);
    expect(a.event_count).toBe(1);

    const b = map.services.find((s) => s.name === 'service-b')!;
    expect(b.endpoint_count).toBe(0);
    expect(b.event_count).toBe(1);
  });

  it('each service entry has expected shape', () => {
    seedTwoServices(ctx);
    const map = getServiceMap(ctx.store, ctx.projectRoot, [])._unsafeUnwrap();
    for (const s of map.services) {
      expect(typeof s.name).toBe('string');
      expect(s.type === null || typeof s.type === 'string').toBe(true);
      expect(s.detection_source === null || typeof s.detection_source === 'string').toBe(true);
      expect(typeof s.endpoint_count).toBe('number');
      expect(typeof s.event_count).toBe('number');
    }
  });

  it('stats reflect totals across the topology', () => {
    seedTwoServices(ctx);
    const map = getServiceMap(ctx.store, ctx.projectRoot, [])._unsafeUnwrap();
    expect(map.stats.services).toBe(2);
    expect(map.stats.contracts).toBe(1); // only service-a has a contract
    expect(map.stats.endpoints).toBe(2);
    expect(map.stats.events).toBe(2); // 1 publish + 1 subscribe
    expect(map.stats.crossEdges).toBe(1);
  });
});
