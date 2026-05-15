/**
 * Behavioural coverage for `getServiceDependencies()` (registered as the
 * `get_service_deps` MCP tool). Seeds three services with cross-service
 * edges in both directions, then verifies:
 *   - direction='outgoing' lists only services THIS service calls
 *   - direction='incoming' lists only services that call THIS service
 *   - direction='both' (default) populates both arrays
 *   - unknown service returns NOT_FOUND with candidates
 *   - duplicate edges are grouped with count > 1 and stable shape
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getServiceDependencies } from '../../../src/tools/project/topology.js';
import { TopologyStore } from '../../../src/topology/topology-db.js';

interface Fixture {
  store: TopologyStore;
  dbPath: string;
  projectRoot: string;
  svcAId: number;
  svcBId: number;
  svcCId: number;
}

function seed(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'service-deps-'));
  const dbPath = path.join(tmpDir, 'topology.db');
  const projectRoot = path.join(tmpDir, 'workspace');
  fs.mkdirSync(projectRoot, { recursive: true });
  const store = new TopologyStore(dbPath);

  const svcAId = store.upsertService({
    name: 'service-a',
    repoRoot: '/repos/service-a',
    dbPath: '/fake/a.db',
    serviceType: 'api',
    detectionSource: 'test',
  });
  const svcBId = store.upsertService({
    name: 'service-b',
    repoRoot: '/repos/service-b',
    dbPath: '/fake/b.db',
    serviceType: 'worker',
    detectionSource: 'test',
  });
  const svcCId = store.upsertService({
    name: 'service-c',
    repoRoot: '/repos/service-c',
    dbPath: '/fake/c.db',
    serviceType: 'api',
    detectionSource: 'test',
  });

  // service-a calls service-b (api_call) — two distinct edges (different refs)
  // so the grouping produces count=2 under the (target,edge_type) key.
  store.insertCrossServiceEdge({
    sourceServiceId: svcAId,
    targetServiceId: svcBId,
    edgeType: 'api_call',
    sourceRef: 'src/a/one.ts',
    targetRef: 'GET /work',
    confidence: 0.9,
  });
  store.insertCrossServiceEdge({
    sourceServiceId: svcAId,
    targetServiceId: svcBId,
    edgeType: 'api_call',
    sourceRef: 'src/a/two.ts',
    targetRef: 'POST /work',
    confidence: 0.9,
  });
  // service-a calls service-c via event_publish (different edge_type).
  store.insertCrossServiceEdge({
    sourceServiceId: svcAId,
    targetServiceId: svcCId,
    edgeType: 'event_publish',
    sourceRef: 'src/a/three.ts',
    targetRef: 'user.created',
    confidence: 1.0,
  });
  // service-c calls service-a back (api_call) → incoming on service-a.
  store.insertCrossServiceEdge({
    sourceServiceId: svcCId,
    targetServiceId: svcAId,
    edgeType: 'api_call',
    sourceRef: 'src/c/index.ts',
    targetRef: 'GET /status',
    confidence: 0.7,
  });

  return { store, dbPath, projectRoot, svcAId, svcBId, svcCId };
}

describe('getServiceDependencies() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    ctx.store.close();
    fs.rmSync(path.dirname(ctx.dbPath), { recursive: true, force: true });
  });

  it("direction='outgoing' lists only services THIS service calls", () => {
    const result = getServiceDependencies(ctx.store, ctx.projectRoot, [], {
      service: 'service-a',
      direction: 'outgoing',
    });
    expect(result.isOk()).toBe(true);
    const deps = result._unsafeUnwrap();
    expect(deps.service).toBe('service-a');
    expect(deps.incoming).toEqual([]);
    // outgoing has two grouped rows: service-b/api_call (count=2) and service-c/event_publish (count=1).
    expect(deps.outgoing.length).toBe(2);
    const byTarget = new Map(deps.outgoing.map((o) => [`${o.target}|${o.edge_type}`, o.count]));
    expect(byTarget.get('service-b|api_call')).toBe(2);
    expect(byTarget.get('service-c|event_publish')).toBe(1);
  });

  it("direction='incoming' lists only services that call THIS service", () => {
    const deps = getServiceDependencies(ctx.store, ctx.projectRoot, [], {
      service: 'service-a',
      direction: 'incoming',
    })._unsafeUnwrap();

    expect(deps.outgoing).toEqual([]);
    expect(deps.incoming).toHaveLength(1);
    expect(deps.incoming[0]).toMatchObject({
      source: 'service-c',
      edge_type: 'api_call',
      count: 1,
    });
  });

  it("direction='both' (default) populates both arrays", () => {
    const deps = getServiceDependencies(ctx.store, ctx.projectRoot, [], {
      service: 'service-a',
    })._unsafeUnwrap();

    expect(deps.outgoing.length).toBe(2);
    expect(deps.incoming.length).toBe(1);
  });

  it('unknown service returns NOT_FOUND with candidates', () => {
    const result = getServiceDependencies(ctx.store, ctx.projectRoot, [], {
      service: 'no-such-service',
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('NOT_FOUND');
    if (error.code === 'NOT_FOUND') {
      expect(error.candidates).toEqual(
        expect.arrayContaining(['service-a', 'service-b', 'service-c']),
      );
    }
  });

  it('each dep entry has expected shape (target/source + edge_type + count)', () => {
    const deps = getServiceDependencies(ctx.store, ctx.projectRoot, [], {
      service: 'service-a',
    })._unsafeUnwrap();

    expect(typeof deps.service).toBe('string');
    expect(Array.isArray(deps.outgoing)).toBe(true);
    expect(Array.isArray(deps.incoming)).toBe(true);

    for (const o of deps.outgoing) {
      expect(typeof o.target).toBe('string');
      expect(typeof o.edge_type).toBe('string');
      expect(typeof o.count).toBe('number');
      expect(o.count).toBeGreaterThan(0);
    }
    for (const i of deps.incoming) {
      expect(typeof i.source).toBe('string');
      expect(typeof i.edge_type).toBe('string');
      expect(typeof i.count).toBe('number');
      expect(i.count).toBeGreaterThan(0);
    }
  });
});
