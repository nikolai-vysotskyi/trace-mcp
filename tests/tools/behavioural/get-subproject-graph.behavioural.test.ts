/**
 * Behavioural coverage for `getSubprojectGraph()`. Seeds a TopologyStore with
 * subprojects, services, endpoints, and client calls, then verifies the shape
 * of the returned graph: repos[], edges[], stats, and the empty contract when
 * no subprojects are registered.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSubprojectGraph } from '../../../src/tools/advanced/subproject.js';
import { TopologyStore } from '../../../src/topology/topology-db.js';

interface Fixture {
  store: TopologyStore;
  dbPath: string;
  serviceAId: number;
  serviceBId: number;
  endpointAId: number;
  repoAId: number;
  repoBId: number;
}

function makeStore(): { store: TopologyStore; dbPath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-graph-'));
  const dbPath = path.join(tmpDir, 'topology.db');
  return { store: new TopologyStore(dbPath), dbPath };
}

/**
 * Build a topology with:
 *   - repo-a (service-a, endpoint GET /users)
 *   - repo-b (service-b, no endpoints) with one client call from
 *     repo-b -> repo-a's endpoint, linked via matched_endpoint_id.
 *
 * The linked client call should produce one inter-repo edge in the graph.
 */
function seed(): Fixture {
  const { store, dbPath } = makeStore();

  // Services
  const serviceAId = store.upsertService({
    name: 'service-a',
    repoRoot: '/repos/repo-a',
    dbPath: '/fake/a.db',
    serviceType: 'api',
    detectionSource: 'test',
  });
  const serviceBId = store.upsertService({
    name: 'service-b',
    repoRoot: '/repos/repo-b',
    dbPath: '/fake/b.db',
    serviceType: 'api',
    detectionSource: 'test',
  });

  // One contract + one endpoint on service-a
  const contractAId = store.insertContract(serviceAId, {
    contractType: 'openapi',
    specPath: '/repos/repo-a/openapi.yaml',
    parsedSpec: '{}',
  });
  store.insertEndpoints(contractAId, serviceAId, [{ method: 'GET', path: '/users' }]);
  const allEndpoints = store.getAllEndpoints();
  const endpointAId = allEndpoints[0].id;

  // Subprojects (must use the same repo_root as the services so list() ties them)
  const repoAId = store.upsertSubproject({
    name: 'repo-a',
    repoRoot: '/repos/repo-a',
    projectRoot: '/workspace',
  });
  const repoBId = store.upsertSubproject({
    name: 'repo-b',
    repoRoot: '/repos/repo-b',
    projectRoot: '/workspace',
  });

  // Client call: repo-b calls repo-a's /users endpoint
  store.insertClientCalls([
    {
      sourceRepoId: repoBId,
      targetRepoId: repoAId,
      filePath: 'src/api/users.ts',
      line: 10,
      callType: 'fetch',
      method: 'GET',
      urlPattern: '/users',
      matchedEndpointId: endpointAId,
      confidence: 0.95,
    },
  ]);

  return { store, dbPath, serviceAId, serviceBId, endpointAId, repoAId, repoBId };
}

describe('getSubprojectGraph() — behavioural contract', () => {
  let ctx: Fixture | undefined;
  let emptyStore: { store: TopologyStore; dbPath: string } | undefined;

  afterEach(() => {
    if (ctx) {
      ctx.store.close();
      fs.rmSync(path.dirname(ctx.dbPath), { recursive: true, force: true });
      ctx = undefined;
    }
    if (emptyStore) {
      emptyStore.store.close();
      fs.rmSync(path.dirname(emptyStore.dbPath), { recursive: true, force: true });
      emptyStore = undefined;
    }
  });

  it('empty topology returns empty repos/edges and zero stats', () => {
    emptyStore = makeStore();
    const result = getSubprojectGraph(emptyStore.store);
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    expect(graph.repos).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.stats.repos).toBe(0);
    expect(graph.stats.totalEndpoints).toBe(0);
    expect(graph.stats.totalClientCalls).toBe(0);
    expect(graph.stats.linkedCallsPercent).toBe(0);
  });

  it('seeded topology surfaces both subprojects in repos[]', () => {
    ctx = seed();
    const result = getSubprojectGraph(ctx.store);
    expect(result.isOk()).toBe(true);
    const graph = result._unsafeUnwrap();
    const names = graph.repos.map((r) => r.name).sort();
    expect(names).toEqual(['repo-a', 'repo-b']);
  });

  it('each repo entry has expected shape with services/endpoints/clientCalls counts', () => {
    ctx = seed();
    const graph = getSubprojectGraph(ctx.store)._unsafeUnwrap();
    for (const repo of graph.repos) {
      expect(typeof repo.name).toBe('string');
      expect(typeof repo.repoRoot).toBe('string');
      expect(typeof repo.services).toBe('number');
      expect(typeof repo.endpoints).toBe('number');
      expect(typeof repo.clientCalls).toBe('number');
    }

    const repoA = graph.repos.find((r) => r.name === 'repo-a')!;
    expect(repoA.services).toBe(1);
    expect(repoA.endpoints).toBe(1);
    // repo-a has no outgoing client calls
    expect(repoA.clientCalls).toBe(0);

    const repoB = graph.repos.find((r) => r.name === 'repo-b')!;
    expect(repoB.services).toBe(1);
    expect(repoB.endpoints).toBe(0);
    // repo-b has one outgoing call
    expect(repoB.clientCalls).toBe(1);
  });

  it('linked client calls produce inter-repo edges', () => {
    ctx = seed();
    const graph = getSubprojectGraph(ctx.store)._unsafeUnwrap();
    expect(graph.edges).toHaveLength(1);
    const edge = graph.edges[0];
    expect(edge.source).toBe('repo-b');
    expect(edge.target).toBe('repo-a');
    expect(edge.callCount).toBe(1);
    expect(edge.linkedCount).toBe(1);
    expect(edge.callTypes).toContain('fetch');
  });

  it('stats reflect totals across the topology', () => {
    ctx = seed();
    const graph = getSubprojectGraph(ctx.store)._unsafeUnwrap();
    expect(graph.stats.repos).toBe(2);
    expect(graph.stats.totalEndpoints).toBe(1);
    expect(graph.stats.totalClientCalls).toBe(1);
    // 1 of 1 client calls are linked → 100%
    expect(graph.stats.linkedCallsPercent).toBe(100);
  });
});
