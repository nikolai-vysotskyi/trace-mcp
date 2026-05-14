/**
 * Behavioural coverage for `getArtifacts()`. Seeds the index with ORM models,
 * migrations, routes, infra YAML symbols, and CI job symbols, then verifies
 * category filtering, text query filter, limit, and empty-index contract.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getArtifacts } from '../../../src/tools/project/artifacts.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

function seed(): Fixture {
  const store = createTestStore();

  // ── database ───────────────────────────────────────────────
  const modelFid = store.insertFile('src/models/User.ts', 'typescript', 'h-m', 100);
  store.insertOrmModel({ name: 'User', orm: 'prisma', collectionOrTable: 'users' }, modelFid);

  const migFid = store.insertFile('database/migrations/001.ts', 'typescript', 'h-mig', 80);
  store.insertMigration({ tableName: 'users', operation: 'create_table' }, migFid);

  // ── api ────────────────────────────────────────────────────
  const routesFid = store.insertFile('src/routes.ts', 'typescript', 'h-r', 50);
  store.insertRoute(
    {
      uri: '/api/users',
      method: 'GET',
      handler: 'UserController@index',
      filePath: 'src/routes.ts',
    } as never,
    routesFid,
  );
  store.insertRoute(
    {
      uri: '/api/products',
      method: 'GET',
      handler: 'ProductController@index',
      filePath: 'src/routes.ts',
    } as never,
    routesFid,
  );

  // ── infra ──────────────────────────────────────────────────
  const composeFid = store.insertFile('docker-compose.yml', 'yaml', 'h-d', 60);
  store.insertSymbol(composeFid, {
    symbolId: 'docker-compose.yml::web#class',
    name: 'web',
    kind: 'class',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 1,
    lineEnd: 5,
    metadata: { yamlKind: 'service' },
  } as never);

  // ── ci ─────────────────────────────────────────────────────
  const ciFid = store.insertFile('.github/workflows/ci.yml', 'yaml', 'h-c', 60);
  store.insertSymbol(ciFid, {
    symbolId: '.github/workflows/ci.yml::build#function',
    name: 'build',
    kind: 'function',
    byteStart: 0,
    byteEnd: 30,
    lineStart: 5,
    lineEnd: 10,
    metadata: { yamlKind: 'job' },
  } as never);

  return { store };
}

describe('getArtifacts() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it("category='database' returns ORM models and migrations only", () => {
    const result = getArtifacts(ctx.store, { category: 'database' });
    const categories = new Set(result.artifacts.map((a) => a.category));
    expect(categories).toEqual(new Set(['database']));

    const ormModel = result.artifacts.find((a) => a.kind === 'orm_model');
    expect(ormModel).toBeDefined();
    expect(ormModel!.name).toBe('User');

    const migration = result.artifacts.find((a) => a.kind === 'migration');
    expect(migration).toBeDefined();
    expect(migration!.name).toBe('users');
  });

  it("category='api' returns route artifacts", () => {
    const result = getArtifacts(ctx.store, { category: 'api' });
    const categories = new Set(result.artifacts.map((a) => a.category));
    expect(categories).toEqual(new Set(['api']));
    expect(result.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(result.artifacts.some((a) => a.name === 'GET /api/users')).toBe(true);
    expect(result.artifacts.some((a) => a.name === 'GET /api/products')).toBe(true);
  });

  it("category='all' returns artifacts from every category present", () => {
    const result = getArtifacts(ctx.store, { category: 'all' });
    const categories = new Set(result.artifacts.map((a) => a.category));
    // At minimum: database, api, infra, ci should appear.
    expect(categories.has('database')).toBe(true);
    expect(categories.has('api')).toBe(true);
    expect(categories.has('infra')).toBe(true);
    expect(categories.has('ci')).toBe(true);
  });

  it('query text filter narrows by name/kind/file substring', () => {
    const result = getArtifacts(ctx.store, { category: 'api', query: 'users' });
    expect(result.artifacts.length).toBe(1);
    expect(result.artifacts[0].name).toBe('GET /api/users');
  });

  it('limit caps the returned artifact count', () => {
    const result = getArtifacts(ctx.store, { category: 'all', limit: 2 });
    expect(result.artifacts).toHaveLength(2);
  });

  it('empty index returns empty artifacts and empty summary', () => {
    const empty = createTestStore();
    const result = getArtifacts(empty, {});
    expect(result.artifacts).toEqual([]);
    expect(result.summary).toEqual({});
  });

  it('output shape: each artifact has category + kind + name + file', () => {
    const result = getArtifacts(ctx.store, { category: 'all' });
    for (const artifact of result.artifacts) {
      expect(typeof artifact.category).toBe('string');
      expect(typeof artifact.kind).toBe('string');
      expect(typeof artifact.name).toBe('string');
      expect(typeof artifact.file).toBe('string');
    }
  });
});
