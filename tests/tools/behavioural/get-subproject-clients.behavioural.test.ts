/**
 * Behavioural coverage for `getSubprojectClients()`. Verifies endpoint-path
 * substring matching, method filter, empty contract, and per-client shape
 * (repo + filePath + line + callType + confidence).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSubprojectClients } from '../../../src/tools/advanced/subproject.js';
import { TopologyStore } from '../../../src/topology/topology-db.js';

interface Fixture {
  store: TopologyStore;
  dbPath: string;
}

function seed(): Fixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-clients-'));
  const dbPath = path.join(tmpDir, 'topology.db');
  const store = new TopologyStore(dbPath);

  const svcA = store.upsertService({
    name: 'service-a',
    repoRoot: '/repos/repo-a',
    dbPath: '/fake/a.db',
    serviceType: 'api',
    detectionSource: 'test',
  });
  const contract = store.insertContract(svcA, {
    contractType: 'openapi',
    specPath: '/repos/repo-a/openapi.yaml',
    parsedSpec: '{}',
  });
  store.insertEndpoints(contract, svcA, [
    { method: 'GET', path: '/users' },
    { method: 'POST', path: '/users' },
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
      confidence: 0.87,
    },
    {
      sourceRepoId: repoB,
      targetRepoId: repoA,
      filePath: 'src/api/users.ts',
      line: 80,
      callType: 'axios',
      method: 'POST',
      urlPattern: '/users',
      matchedEndpointId: postUsers.id,
      confidence: 0.91,
    },
  ]);

  return { store, dbPath };
}

describe('getSubprojectClients() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  afterEach(() => {
    ctx.store.close();
    fs.rmSync(path.dirname(ctx.dbPath), { recursive: true, force: true });
  });

  it('returns clients for endpoints whose path matches the query substring', () => {
    const result = getSubprojectClients(ctx.store, { endpoint: '/users' });
    expect(result.isOk()).toBe(true);
    const list = result._unsafeUnwrap();
    // Two endpoints match "/users" → two grouped results.
    expect(list).toHaveLength(2);
    const allClients = list.flatMap((entry) => entry.clients);
    expect(allClients.length).toBe(2);
  });

  it('method filter narrows endpoints to that HTTP verb', () => {
    const result = getSubprojectClients(ctx.store, { endpoint: '/users', method: 'POST' });
    const list = result._unsafeUnwrap();
    expect(list).toHaveLength(1);
    expect(list[0].endpoint.method).toBe('POST');
    expect(list[0].clients).toHaveLength(1);
    expect(list[0].clients[0].callType).toBe('axios');
  });

  it('no matching endpoints returns empty array', () => {
    const result = getSubprojectClients(ctx.store, { endpoint: '/nope-route' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('each client entry exposes repo + filePath + line + callType + confidence', () => {
    const list = getSubprojectClients(ctx.store, {
      endpoint: '/users',
      method: 'GET',
    })._unsafeUnwrap();
    expect(list).toHaveLength(1);
    const client = list[0].clients[0];
    expect(client.repo).toBe('repo-b');
    expect(client.filePath).toBe('src/api/users.ts');
    expect(client.line).toBe(12);
    expect(client.callType).toBe('fetch');
    expect(typeof client.confidence).toBe('number');
    expect(client.confidence).toBeGreaterThan(0);
  });

  it('output shape: each entry has endpoint + clients[] + totalClients', () => {
    const list = getSubprojectClients(ctx.store, { endpoint: '/users' })._unsafeUnwrap();
    for (const entry of list) {
      expect(entry.endpoint).toBeDefined();
      expect(typeof entry.endpoint.path).toBe('string');
      expect(typeof entry.endpoint.service).toBe('string');
      expect(Array.isArray(entry.clients)).toBe(true);
      expect(typeof entry.totalClients).toBe('number');
      expect(entry.totalClients).toBe(entry.clients.length);
    }
  });
});
