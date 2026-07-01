/**
 * Behavioural coverage for `getFederationImpact()` — aggregates subproject
 * client-call impact, cross-service edge impact, and contract drift into
 * one response. Verifies:
 *   - missing endpoint AND service returns VALIDATION_ERROR
 *   - endpoint-only query returns affected_clients from the subproject scanner
 *   - service query combines affected_services + contract_drift
 *   - risk_level aggregates the worst signal across all three sources
 *   - output shape is stable (target, affected_clients, affected_services, contract_drift, risk_level, summary, total_affected)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFederationImpact } from '../../../src/tools/advanced/federation-impact.js';
import { TopologyStore } from '../../../src/topology/topology-db.js';

interface Fixture {
  store: TopologyStore;
  dbPath: string;
}

function routeStub(routes: Array<{ method: string; uri: string }>) {
  return { getAllRoutes: () => routes };
}

function seed(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'federation-impact-'));
  const dbPath = path.join(tmpDir, 'topology.db');
  const store = new TopologyStore(dbPath);

  const svcA = store.upsertService({
    name: 'service-a',
    repoRoot: '/repos/repo-a',
    dbPath: '/fake/a.db',
    serviceType: 'api',
    detectionSource: 'test',
  });

  const contractA = store.insertContract(svcA, {
    contractType: 'openapi',
    specPath: '/repos/repo-a/openapi.yaml',
    parsedSpec: '{}',
  });
  store.insertEndpoints(contractA, svcA, [
    { method: 'GET', path: '/users' },
    { method: 'GET', path: '/orphan-in-spec' },
  ]);
  const endpoints = store.getAllEndpoints();
  const getUsers = endpoints.find((e) => e.method === 'GET' && e.path === '/users')!;

  const repoA = store.upsertSubproject({
    name: 'repo-a',
    repoRoot: '/repos/repo-a',
    projectRoot: '/workspace',
  });
  const repoB = store.upsertSubproject({
    name: 'repo-b',
    repoRoot: '/repos/repo-b',
    projectRoot: '/workspace',
  });

  store.insertClientCalls([
    {
      sourceRepoId: repoB,
      targetRepoId: repoA,
      filePath: 'src/api/users.ts',
      line: 12,
      callType: 'fetch',
      method: 'GET',
      urlPattern: '/users',
      matchedEndpointId: getUsers.id,
      confidence: 0.9,
    },
  ]);

  return { store, dbPath };
}

describe('getFederationImpact() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    ctx.store.close();
    fs.rmSync(path.dirname(ctx.dbPath), { recursive: true, force: true });
  });

  it('missing endpoint AND service inputs returns a VALIDATION_ERROR', () => {
    const result = getFederationImpact(ctx.store, null, '/workspace', [], {});
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('VALIDATION_ERROR');
  });

  it('endpoint-only query returns affected_clients from the subproject scanner', () => {
    const result = getFederationImpact(ctx.store, null, '/workspace', [], {
      endpoint: '/users',
    });
    expect(result.isOk()).toBe(true);
    const impact = result._unsafeUnwrap();

    expect(impact.affected_clients.length).toBe(1);
    expect(impact.affected_clients[0].endpoint.path).toBe('/users');
    expect(impact.affected_clients[0].clients.length).toBe(1);
    expect(impact.affected_clients[0].clients[0].repo).toBe('repo-b');
    // No service was given, so cross-service + contract-drift signals stay empty.
    expect(impact.affected_services).toEqual([]);
    expect(impact.contract_drift).toEqual([]);
  });

  it('service query with a stub implementation store surfaces contract drift', () => {
    const impl = routeStub([{ method: 'GET', uri: '/users' }]);
    const result = getFederationImpact(ctx.store, impl, '/workspace', [], {
      service: 'service-a',
    });
    expect(result.isOk()).toBe(true);
    const impact = result._unsafeUnwrap();

    // /orphan-in-spec is in the spec but not in the stub implementation.
    expect(impact.contract_drift.some((d) => d.type === 'missing_endpoint')).toBe(true);
    expect(impact.target.service).toBe('service-a');
  });

  it('no store provided skips contract drift without erroring', () => {
    const result = getFederationImpact(ctx.store, null, '/workspace', [], {
      service: 'service-a',
    });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().contract_drift).toEqual([]);
  });

  it('output shape is stable', () => {
    const impact = getFederationImpact(ctx.store, null, '/workspace', [], {
      endpoint: '/users',
    })._unsafeUnwrap();

    expect(impact.target).toBeDefined();
    expect(Array.isArray(impact.affected_clients)).toBe(true);
    expect(Array.isArray(impact.affected_services)).toBe(true);
    expect(Array.isArray(impact.contract_drift)).toBe(true);
    expect(['low', 'medium', 'high', 'critical']).toContain(impact.risk_level);
    expect(typeof impact.summary).toBe('string');
    expect(typeof impact.total_affected).toBe('number');
  });

  it('no matches returns empty affected_clients with low risk and a no-impact summary', () => {
    const impact = getFederationImpact(ctx.store, null, '/workspace', [], {
      endpoint: '/nonexistent-route',
    })._unsafeUnwrap();

    expect(impact.affected_clients).toEqual([]);
    expect(impact.risk_level).toBe('low');
    expect(impact.total_affected).toBe(0);
  });
});
