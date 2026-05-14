/**
 * Behavioural coverage for `getSubprojectImpact()`. Verifies endpoint pattern
 * matching, HTTP method filter, missing-input validation, and shape of the
 * returned cross-repo impact list (clients[], riskLevel, summary).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSubprojectImpact } from '../../../src/tools/advanced/subproject.js';
import { TopologyStore } from '../../../src/topology/topology-db.js';

interface Fixture {
  store: TopologyStore;
  dbPath: string;
}

function seed(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-impact-'));
  const dbPath = path.join(tmpDir, 'topology.db');
  const store = new TopologyStore(dbPath);

  // Service-a exposes GET /users and POST /users; service-b is the caller.
  const svcA = store.upsertService({
    name: 'service-a',
    repoRoot: '/repos/repo-a',
    dbPath: '/fake/a.db',
    serviceType: 'api',
    detectionSource: 'test',
  });
  const svcB = store.upsertService({
    name: 'service-b',
    repoRoot: '/repos/repo-b',
    dbPath: '/fake/b.db',
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
    { method: 'POST', path: '/users' },
    { method: 'GET', path: '/health' },
  ]);
  const endpoints = store.getAllEndpoints();
  const getUsers = endpoints.find((e) => e.method === 'GET' && e.path === '/users')!;
  const postUsers = endpoints.find((e) => e.method === 'POST' && e.path === '/users')!;

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

  // Two callers of GET /users (one from repo-b), one caller of POST /users.
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
    {
      sourceRepoId: repoB,
      targetRepoId: repoA,
      filePath: 'src/api/users.ts',
      line: 42,
      callType: 'fetch',
      method: 'POST',
      urlPattern: '/users',
      matchedEndpointId: postUsers.id,
      confidence: 0.9,
    },
  ]);

  // Suppress unused-var warning for svcB
  void svcB;

  return { store, dbPath };
}

describe('getSubprojectImpact() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    ctx.store.close();
    fs.rmSync(path.dirname(ctx.dbPath), { recursive: true, force: true });
  });

  it('endpoint filter returns matching results across subprojects', () => {
    const result = getSubprojectImpact(ctx.store, { endpoint: '/users' });
    expect(result.isOk()).toBe(true);
    const impacts = result._unsafeUnwrap();
    // Both GET /users and POST /users contain "/users" — should return 2 entries.
    expect(impacts.length).toBe(2);
    const paths = impacts.map((i) => i.endpoint.path);
    expect(paths.every((p) => p === '/users')).toBe(true);
  });

  it('method filter narrows results to that HTTP verb', () => {
    const result = getSubprojectImpact(ctx.store, { endpoint: '/users', method: 'GET' });
    expect(result.isOk()).toBe(true);
    const impacts = result._unsafeUnwrap();
    expect(impacts).toHaveLength(1);
    expect(impacts[0].endpoint.method).toBe('GET');
    expect(impacts[0].endpoint.path).toBe('/users');
  });

  it('no matches returns empty array (no error)', () => {
    const result = getSubprojectImpact(ctx.store, { endpoint: '/nonexistent-route' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('each impact entry has expected shape (endpoint + clients + riskLevel + summary)', () => {
    const impacts = getSubprojectImpact(ctx.store, {
      endpoint: '/users',
      method: 'GET',
    })._unsafeUnwrap();
    expect(impacts).toHaveLength(1);
    const impact = impacts[0];

    expect(typeof impact.endpoint.path).toBe('string');
    expect(typeof impact.endpoint.service).toBe('string');
    expect(impact.endpoint.repo).toBe('repo-a');

    expect(Array.isArray(impact.clients)).toBe(true);
    expect(impact.clients.length).toBeGreaterThan(0);
    for (const client of impact.clients) {
      expect(typeof client.repo).toBe('string');
      expect(typeof client.filePath).toBe('string');
      expect(typeof client.callType).toBe('string');
    }

    expect(typeof impact.riskLevel).toBe('string');
    expect(typeof impact.summary).toBe('string');
  });

  it('missing endpoint AND service inputs returns a VALIDATION_ERROR', () => {
    const result = getSubprojectImpact(ctx.store, {});
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    // errors.ts uses code VALIDATION_ERROR for validationError() helper.
    expect(error.code).toBe('VALIDATION_ERROR');
  });
});
