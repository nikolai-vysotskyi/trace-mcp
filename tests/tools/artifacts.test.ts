import { describe, test, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { getArtifacts } from '../../src/tools/project/artifacts.js';

function createStore(): Store {
  const db = initializeDatabase(':memory:');
  return new Store(db);
}

describe('Context Artifacts', () => {
  let store: Store;

  beforeEach(() => {
    store = createStore();
  });

  test('returns empty when no data', () => {
    const result = getArtifacts(store, {});
    expect(result.artifacts).toHaveLength(0);
    expect(result.summary).toEqual({});
  });

  test('collects ORM model artifacts', () => {
    const fileId = store.insertFile('src/models/User.ts', 'typescript', 'h1', 100);
    store.insertOrmModel({
      name: 'User',
      orm: 'prisma',
      collectionOrTable: 'users',
    }, fileId);

    const result = getArtifacts(store, { category: 'database' });
    expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
    const model = result.artifacts.find((a) => a.kind === 'orm_model' && a.name === 'User');
    expect(model).toBeDefined();
    expect(model!.details?.orm).toBe('prisma');
    expect(model!.details?.table).toBe('users');
    expect(result.summary.database).toBeGreaterThanOrEqual(1);
  });

  test('collects migration artifacts', () => {
    const fileId = store.insertFile('database/migrations/001.ts', 'typescript', 'h1', 100);
    store.insertMigration({
      tableName: 'users',
      operation: 'create_table',
    }, fileId);

    const result = getArtifacts(store, { category: 'database' });
    const migration = result.artifacts.find((a) => a.kind === 'migration');
    expect(migration).toBeDefined();
    expect(migration!.name).toBe('users');
    expect(migration!.details?.table).toBe('users');
    expect(migration!.details?.operation).toBe('create_table');
  });

  test('collects route artifacts', () => {
    const fileId = store.insertFile('src/routes.ts', 'typescript', 'h1', 100);
    store.insertRoute({
      uri: '/api/users',
      method: 'GET',
      handler: 'UserController@index',
      filePath: 'src/routes.ts',
    });
    store.insertRoute({
      uri: '/api/users',
      method: 'POST',
      handler: 'UserController@store',
      filePath: 'src/routes.ts',
    });

    const result = getArtifacts(store, { category: 'api' });
    expect(result.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(result.artifacts.some((a) => a.name === 'GET /api/users')).toBe(true);
    expect(result.artifacts.some((a) => a.name === 'POST /api/users')).toBe(true);
  });

  test('collects infra artifacts from docker-compose symbols', () => {
    const fileId = store.insertFile('docker-compose.yml', 'yaml', 'h1', 100);
    store.insertSymbol(fileId, {
      symbolId: 'docker-compose.yml::web#class',
      name: 'web',
      kind: 'class',
      byteStart: 0,
      byteEnd: 50,
      lineStart: 1,
      lineEnd: 5,
      metadata: { yamlKind: 'service' },
    } as any);
    store.insertSymbol(fileId, {
      symbolId: 'docker-compose.yml::web:image#constant',
      name: 'web:image',
      kind: 'constant',
      byteStart: 51,
      byteEnd: 80,
      lineStart: 3,
      lineEnd: 3,
      metadata: { yamlKind: 'image', value: 'nginx:latest' },
    } as any);

    const result = getArtifacts(store, { category: 'infra' });
    expect(result.artifacts.some((a) => a.kind === 'service' && a.name === 'web')).toBe(true);
    expect(result.artifacts.some((a) => a.kind === 'image')).toBe(true);
  });

  test('collects CI artifacts from GitHub Actions symbols', () => {
    const fileId = store.insertFile('.github/workflows/ci.yml', 'yaml', 'h1', 100);
    store.insertSymbol(fileId, {
      symbolId: '.github/workflows/ci.yml::build#function',
      name: 'build',
      kind: 'function',
      byteStart: 0,
      byteEnd: 50,
      lineStart: 5,
      lineEnd: 10,
      metadata: { yamlKind: 'job' },
    } as any);

    const result = getArtifacts(store, { category: 'ci' });
    expect(result.artifacts.some((a) => a.kind === 'job' && a.name === 'build')).toBe(true);
    expect(result.summary.ci).toBeGreaterThanOrEqual(1);
  });

  test('text query filters artifacts', () => {
    const fileId = store.insertFile('src/routes.ts', 'typescript', 'h1', 100);
    store.insertRoute({ uri: '/api/users', method: 'GET', handler: 'UserController@index', filePath: 'src/routes.ts' });
    store.insertRoute({ uri: '/api/products', method: 'GET', handler: 'ProductController@index', filePath: 'src/routes.ts' });

    const result = getArtifacts(store, { category: 'api', query: 'users' });
    expect(result.artifacts.length).toBe(1);
    expect(result.artifacts[0].name).toContain('users');
  });

  test('respects limit', () => {
    const fileId = store.insertFile('src/routes.ts', 'typescript', 'h1', 100);
    for (let i = 0; i < 10; i++) {
      store.insertRoute({ uri: `/api/r${i}`, method: 'GET', handler: `C@a${i}`, filePath: 'src/routes.ts' });
    }

    const result = getArtifacts(store, { category: 'api', limit: 3 });
    expect(result.artifacts.length).toBe(3);
  });

  test('category=all collects from all categories', () => {
    const f1 = store.insertFile('src/routes.ts', 'typescript', 'h1', 100);
    store.insertRoute({ uri: '/api/users', method: 'GET', handler: 'X', filePath: 'src/routes.ts' });

    const f2 = store.insertFile('.github/workflows/ci.yml', 'yaml', 'h2', 100);
    store.insertSymbol(f2, {
      symbolId: 'ci.yml::build#function',
      name: 'build',
      kind: 'function',
      byteStart: 0, byteEnd: 50, lineStart: 1, lineEnd: 5,
      metadata: { yamlKind: 'job' },
    } as any);

    const result = getArtifacts(store, { category: 'all' });
    const categories = new Set(result.artifacts.map((a) => a.category));
    expect(categories.has('api')).toBe(true);
    expect(categories.has('ci')).toBe(true);
  });

  test('does not include event/store routes as API artifacts', () => {
    const fileId = store.insertFile('src/events.ts', 'typescript', 'h1', 100);
    store.insertRoute({ uri: 'user.created', method: 'EVENT', handler: 'UserCreated', filePath: 'src/events.ts' });
    store.insertRoute({ uri: '/api/users', method: 'GET', handler: 'X', filePath: 'src/events.ts' });

    const result = getArtifacts(store, { category: 'api' });
    // Only the GET route, not the EVENT
    expect(result.artifacts.every((a) => a.details?.method !== 'EVENT')).toBe(true);
    expect(result.artifacts.some((a) => a.name === 'GET /api/users')).toBe(true);
  });
});
