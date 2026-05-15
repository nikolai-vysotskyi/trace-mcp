/**
 * Behavioural coverage for `getContractDrift()`. Compares spec endpoints
 * (from TopologyStore) against an implementation route list (from a stub
 * store with getAllRoutes), then verifies:
 *   - spec endpoints not in code surface as `missing_endpoint`
 *   - code endpoints not in spec surface as `extra_endpoint`
 *   - no drift returns empty drifts array
 *   - unknown service returns NOT_FOUND
 *   - output shape (service, drifts[]) is stable
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getContractDrift } from '../../../src/tools/project/topology.js';
import { TopologyStore } from '../../../src/topology/topology-db.js';

interface Fixture {
  store: TopologyStore;
  dbPath: string;
}

function seed(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-drift-'));
  const dbPath = path.join(tmpDir, 'topology.db');
  const store = new TopologyStore(dbPath);

  const svcId = store.upsertService({
    name: 'drift-svc',
    repoRoot: '/repos/drift',
    dbPath: '/fake/drift.db',
    serviceType: 'api',
    detectionSource: 'test',
  });
  const contractId = store.insertContract(svcId, {
    contractType: 'openapi',
    specPath: '/repos/drift/openapi.yaml',
    parsedSpec: '{}',
  });
  store.insertEndpoints(contractId, svcId, [
    { method: 'GET', path: '/users' },
    { method: 'POST', path: '/users' },
    { method: 'GET', path: '/orphan-in-spec' },
  ]);

  return { store, dbPath };
}

/** Stub for the second `store` argument: just exposes getAllRoutes(). */
function routeStub(routes: Array<{ method: string; uri: string }>) {
  return { getAllRoutes: () => routes };
}

describe('getContractDrift() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    ctx.store.close();
    fs.rmSync(path.dirname(ctx.dbPath), { recursive: true, force: true });
  });

  it('spec endpoints not in code surface as missing_endpoint', () => {
    // Implementation only has GET /users — POST /users and /orphan-in-spec are missing.
    const impl = routeStub([{ method: 'GET', uri: '/users' }]);
    const result = getContractDrift(ctx.store, impl, '/workspace', [], { service: 'drift-svc' });
    expect(result.isOk()).toBe(true);
    const drift = result._unsafeUnwrap();

    const missing = drift.drifts.filter((d) => d.type === 'missing_endpoint');
    expect(missing.length).toBe(2);
    expect(missing.some((d) => d.detail.includes('/orphan-in-spec'))).toBe(true);
    expect(missing.some((d) => d.detail.includes('POST /users'))).toBe(true);
  });

  it('code endpoints not in spec surface as extra_endpoint', () => {
    // Implementation has the spec endpoints + one extra route.
    const impl = routeStub([
      { method: 'GET', uri: '/users' },
      { method: 'POST', uri: '/users' },
      { method: 'GET', uri: '/orphan-in-spec' },
      { method: 'DELETE', uri: '/extra-in-code' },
    ]);
    const drift = getContractDrift(ctx.store, impl, '/workspace', [], {
      service: 'drift-svc',
    })._unsafeUnwrap();

    const extra = drift.drifts.filter((d) => d.type === 'extra_endpoint');
    expect(extra.length).toBe(1);
    expect(extra[0].detail).toContain('/extra-in-code');
    expect(extra[0].detail).toContain('DELETE');
  });

  it('no drift returns empty drifts array', () => {
    // Implementation exactly matches the spec.
    const impl = routeStub([
      { method: 'GET', uri: '/users' },
      { method: 'POST', uri: '/users' },
      { method: 'GET', uri: '/orphan-in-spec' },
    ]);
    const drift = getContractDrift(ctx.store, impl, '/workspace', [], {
      service: 'drift-svc',
    })._unsafeUnwrap();

    expect(drift.service).toBe('drift-svc');
    expect(drift.drifts).toEqual([]);
  });

  it('unknown service returns NOT_FOUND', () => {
    const result = getContractDrift(ctx.store, routeStub([]), '/workspace', [], {
      service: 'no-such-service',
    });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('NOT_FOUND');
    if (error.code === 'NOT_FOUND') {
      expect(error.candidates).toEqual(['drift-svc']);
    }
  });

  it('each drift entry has expected shape (type + detail strings)', () => {
    const impl = routeStub([{ method: 'PATCH', uri: '/only-in-code' }]);
    const drift = getContractDrift(ctx.store, impl, '/workspace', [], {
      service: 'drift-svc',
    })._unsafeUnwrap();

    expect(drift.service).toBe('drift-svc');
    expect(Array.isArray(drift.drifts)).toBe(true);
    expect(drift.drifts.length).toBeGreaterThan(0);
    for (const d of drift.drifts) {
      expect(typeof d.type).toBe('string');
      expect(typeof d.detail).toBe('string');
      expect([
        'missing_endpoint',
        'extra_endpoint',
        'unmatched_spec',
        'schema_breaking_change',
      ]).toContain(d.type);
    }
  });
});
