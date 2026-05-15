/**
 * Behavioural coverage for `getApiContract()`. Seeds a TopologyStore with a
 * service that has openapi + graphql contracts, then verifies:
 *   - service with no contracts returns empty contracts/endpoints/events
 *   - openapi contract surfaces endpoints + correct shape
 *   - contractType filter narrows to matching contracts
 *   - unknown service returns NOT_FOUND with candidates
 *   - output shape (service, contracts, endpoints, events) is stable
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getApiContract } from '../../../src/tools/project/topology.js';
import { TopologyStore } from '../../../src/topology/topology-db.js';

interface Fixture {
  store: TopologyStore;
  dbPath: string;
  emptySvcId: number;
  fullSvcId: number;
}

function seed(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-contract-'));
  const dbPath = path.join(tmpDir, 'topology.db');
  const store = new TopologyStore(dbPath);

  // Service with no contracts at all.
  const emptySvcId = store.upsertService({
    name: 'empty-svc',
    repoRoot: '/repos/empty',
    dbPath: '/fake/empty.db',
    serviceType: 'api',
    detectionSource: 'test',
  });

  // Service with one openapi contract (2 endpoints) and one graphql contract.
  const fullSvcId = store.upsertService({
    name: 'full-svc',
    repoRoot: '/repos/full',
    dbPath: '/fake/full.db',
    serviceType: 'api',
    detectionSource: 'test',
  });

  const openapiContractId = store.insertContract(fullSvcId, {
    contractType: 'openapi',
    specPath: '/repos/full/openapi.yaml',
    version: '1.0.0',
    parsedSpec: '{}',
  });
  store.insertEndpoints(openapiContractId, fullSvcId, [
    { method: 'GET', path: '/users', operationId: 'listUsers' },
    { method: 'POST', path: '/users', operationId: 'createUser' },
  ]);

  const graphqlContractId = store.insertContract(fullSvcId, {
    contractType: 'graphql',
    specPath: '/repos/full/schema.graphql',
    parsedSpec: '{}',
  });
  store.insertEndpoints(graphqlContractId, fullSvcId, [
    { method: null as unknown as string, path: 'Query.user' },
  ]);

  return { store, dbPath, emptySvcId, fullSvcId };
}

describe('getApiContract() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    ctx.store.close();
    fs.rmSync(path.dirname(ctx.dbPath), { recursive: true, force: true });
  });

  it('service with no contracts returns empty contracts/endpoints/events', () => {
    const result = getApiContract(ctx.store, '/workspace', [], { service: 'empty-svc' });
    expect(result.isOk()).toBe(true);
    const contract = result._unsafeUnwrap();
    expect(contract.service).toBe('empty-svc');
    expect(contract.contracts).toEqual([]);
    expect(contract.endpoints).toEqual([]);
    expect(contract.events).toEqual([]);
  });

  it('service with openapi contract surfaces endpoints', () => {
    const contract = getApiContract(ctx.store, '/workspace', [], {
      service: 'full-svc',
    })._unsafeUnwrap();

    expect(contract.service).toBe('full-svc');
    // Both contracts present without filter.
    expect(contract.contracts.length).toBe(2);
    // Endpoints flatten across contracts.
    const paths = contract.endpoints.map((e) => e.path).sort();
    expect(paths).toEqual(['/users', '/users', 'Query.user']);
  });

  it('contractType filter narrows to matching contracts AND scopes endpoints', () => {
    const onlyOpenapi = getApiContract(ctx.store, '/workspace', [], {
      service: 'full-svc',
      contractType: 'openapi',
    })._unsafeUnwrap();

    expect(onlyOpenapi.contracts).toHaveLength(1);
    expect(onlyOpenapi.contracts[0].type).toBe('openapi');
    // Endpoint list must respect the contractType filter — only openapi
    // endpoints should appear, not the graphql "Query.user" row.
    const openapiPaths = onlyOpenapi.endpoints.map((e) => e.path).sort();
    expect(openapiPaths).toEqual(['/users', '/users']);
    expect(onlyOpenapi.endpoints.some((e) => e.path === 'Query.user')).toBe(false);

    const onlyGraphql = getApiContract(ctx.store, '/workspace', [], {
      service: 'full-svc',
      contractType: 'graphql',
    })._unsafeUnwrap();

    expect(onlyGraphql.contracts).toHaveLength(1);
    expect(onlyGraphql.contracts[0].type).toBe('graphql');
    // Symmetric: graphql filter must not surface openapi /users endpoints.
    expect(onlyGraphql.endpoints.map((e) => e.path)).toEqual(['Query.user']);
  });

  it('unknown service returns NOT_FOUND with candidates', () => {
    const result = getApiContract(ctx.store, '/workspace', [], { service: 'nonexistent' });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('NOT_FOUND');
    if (error.code === 'NOT_FOUND') {
      expect(error.candidates).toEqual(expect.arrayContaining(['empty-svc', 'full-svc']));
    }
  });

  it('each contract entry has expected shape (type, spec_path, version, endpoint_count)', () => {
    const contract = getApiContract(ctx.store, '/workspace', [], {
      service: 'full-svc',
    })._unsafeUnwrap();

    for (const c of contract.contracts) {
      expect(typeof c.type).toBe('string');
      expect(typeof c.spec_path).toBe('string');
      // version is string | null
      expect(c.version === null || typeof c.version === 'string').toBe(true);
      expect(typeof c.endpoint_count).toBe('number');
    }

    const openapi = contract.contracts.find((c) => c.type === 'openapi')!;
    expect(openapi.version).toBe('1.0.0');
    expect(openapi.endpoint_count).toBe(2);

    for (const ep of contract.endpoints) {
      // method is string | null per ApiContractResult
      expect(ep.method === null || typeof ep.method === 'string').toBe(true);
      expect(typeof ep.path).toBe('string');
    }
  });
});
