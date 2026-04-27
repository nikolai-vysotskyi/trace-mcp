import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import type { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { getSchema } from '../../src/tools/framework/schema.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/laravel-10');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['app/**/*.php', 'routes/**/*.php', 'database/migrations/**/*.php'],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('get_schema', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();
  });

  it('reconstructs users table from migration', () => {
    const result = getSchema(store, 'users');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { tables } = result.value;
    expect(tables).toHaveLength(1);
    expect(tables[0].tableName).toBe('users');

    const colNames = tables[0].columns.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('email');
    expect(colNames).toContain('password');
  });

  it('returns all tables when no name specified', () => {
    const result = getSchema(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const { tables } = result.value;
    expect(tables.length).toBeGreaterThanOrEqual(2);

    const names = tables.map((t) => t.tableName);
    expect(names).toContain('users');
    expect(names).toContain('posts');
  });

  it('returns empty tables for unknown table', () => {
    const result = getSchema(store, 'nonexistent');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.tables).toHaveLength(0);
  });
});

describe('get_schema — ORM (Mongoose/Sequelize) schemas', () => {
  let store: Store;

  beforeEach(() => {
    store = createTestStore();
  });

  it('returns ormSchemas for Mongoose model', () => {
    const fileId = store.insertFile('models/user.ts', 'typescript', 'h1', 100);
    store.insertOrmModel(
      {
        name: 'User',
        orm: 'mongoose',
        collectionOrTable: 'users',
        fields: [
          { name: 'email', type: 'String', required: true },
          { name: 'name', type: 'String' },
        ],
        metadata: { indexes: [{ fields: { email: 1 }, unique: true }] },
      },
      fileId,
    );

    const result = getSchema(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.ormSchemas).toBeDefined();
    expect(result.value.ormSchemas!.length).toBe(1);

    const userSchema = result.value.ormSchemas![0];
    expect(userSchema.name).toBe('User');
    expect(userSchema.orm).toBe('mongoose');
    expect(userSchema.collection).toBe('users');
    expect(userSchema.fields.length).toBe(2);
    expect(userSchema.indexes).toBeDefined();
  });

  it('filters by model name', () => {
    const fileId = store.insertFile('models/multi.ts', 'typescript', 'h2', 100);
    store.insertOrmModel({ name: 'Post', orm: 'mongoose', collectionOrTable: 'posts' }, fileId);
    store.insertOrmModel(
      { name: 'Comment', orm: 'mongoose', collectionOrTable: 'comments' },
      fileId,
    );

    const result = getSchema(store, 'Post');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.ormSchemas).toBeDefined();
    const names = result.value.ormSchemas!.map((s) => s.name);
    expect(names).toContain('Post');
    expect(names).not.toContain('Comment');
  });

  it('filters by collection name', () => {
    const fileId = store.insertFile('models/cat.ts', 'typescript', 'h3', 100);
    store.insertOrmModel({ name: 'Cat', orm: 'mongoose', collectionOrTable: 'cats' }, fileId);

    const result = getSchema(store, 'cats');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.ormSchemas?.some((s) => s.name === 'Cat')).toBe(true);
  });

  it('returns no ormSchemas when empty', () => {
    const result = getSchema(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    // Either undefined or empty
    expect(!result.value.ormSchemas || result.value.ormSchemas.length === 0).toBe(true);
  });

  it('returns Sequelize model schema', () => {
    const fileId = store.insertFile('models/order.ts', 'typescript', 'h4', 100);
    store.insertOrmModel(
      {
        name: 'Order',
        orm: 'sequelize',
        collectionOrTable: 'orders',
        fields: [
          { name: 'status', type: 'STRING' },
          { name: 'total', type: 'DECIMAL' },
        ],
      },
      fileId,
    );

    const result = getSchema(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const orderSchema = result.value.ormSchemas?.find((s) => s.name === 'Order');
    expect(orderSchema).toBeDefined();
    expect(orderSchema!.orm).toBe('sequelize');
    expect(orderSchema!.fields.length).toBe(2);
  });
});
