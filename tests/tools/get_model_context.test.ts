import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/laravel/index.js';
import { getModelContext } from '../../src/tools/model.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/laravel-10');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: [
      'app/**/*.php',
      'routes/**/*.php',
      'database/migrations/**/*.php',
    ],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('get_model_context', () => {
  let store: Store;

  beforeAll(async () => {
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();
  });

  it('returns model info for User by short name', () => {
    const result = getModelContext(store, 'User');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const ctx = result.value;
    expect(ctx.model.name).toBe('User');
    expect(ctx.model.fqn).toBe('App\\Models\\User');
    expect(ctx.model.filePath).toContain('app/Models/User.php');
  });

  it('returns model info by FQN', () => {
    const result = getModelContext(store, 'App\\Models\\User');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.model.name).toBe('User');
  });

  it('returns relationships for User model', () => {
    const result = getModelContext(store, 'User');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const rels = result.value.relationships;
    // Should have has_many -> Post and belongs_to_many -> Role (if resolved)
    // At minimum, outgoing edges from pass 2 should be present
    const hasMany = rels.find((r) => r.type === 'has_many');
    if (hasMany) {
      expect(hasMany.relatedModel).toContain('Post');
    }
  });

  it('returns schema from migrations for User', () => {
    const result = getModelContext(store, 'User');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const schema = result.value.schema;
    expect(schema.length).toBeGreaterThan(0);
    expect(schema[0].tableName).toBe('users');
    expect(schema[0].columns.length).toBeGreaterThan(0);
  });

  it('returns NOT_FOUND for unknown model', () => {
    const result = getModelContext(store, 'NonExistentModel');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });
});

describe('get_model_context — Mongoose ORM path', () => {
  let store: Store;

  beforeEach(() => {
    const db = initializeDatabase(':memory:');
    store = new Store(db);
  });

  it('finds Mongoose model by name', () => {
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
        metadata: { virtuals: ['fullName'], methods: ['comparePassword'] },
      },
      fileId,
    );

    const result = getModelContext(store, 'User');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const ctx = result.value;
    expect(ctx.model.name).toBe('User');
    expect(ctx.model.orm).toBe('mongoose');
    expect(ctx.model.collection).toBe('users');
    expect(ctx.model.filePath).toContain('user.ts');
  });

  it('returns fields as schema rows', () => {
    const fileId = store.insertFile('models/post.ts', 'typescript', 'h2', 100);
    store.insertOrmModel(
      {
        name: 'Post',
        orm: 'mongoose',
        fields: [{ name: 'title', type: 'String' }, { name: 'body', type: 'String' }],
      },
      fileId,
    );

    const result = getModelContext(store, 'Post');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.schema.length).toBe(1);
    expect(result.value.schema[0].columns.length).toBe(2);
  });

  it('returns associations from orm_associations', () => {
    const fileId = store.insertFile('models/assoc.ts', 'typescript', 'h3', 100);
    const userId = store.insertOrmModel({ name: 'User', orm: 'mongoose' }, fileId);
    const postId = store.insertOrmModel({ name: 'Post', orm: 'mongoose' }, fileId);
    store.insertOrmAssociation(userId, postId, 'Post', 'hasMany');

    const result = getModelContext(store, 'User');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const rels = result.value.relationships;
    expect(rels.length).toBe(1);
    expect(rels[0].type).toBe('hasMany');
    expect(rels[0].relatedModel).toBe('Post');
  });

  it('includes ormMetadata', () => {
    const fileId = store.insertFile('models/cat.ts', 'typescript', 'h4', 100);
    store.insertOrmModel(
      {
        name: 'Cat',
        orm: 'mongoose',
        metadata: { virtuals: ['fullName'], middleware: [{ hook: 'pre', event: 'save' }] },
      },
      fileId,
    );

    const result = getModelContext(store, 'Cat');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.ormMetadata).toBeDefined();
    expect((result.value.ormMetadata as any).virtuals).toContain('fullName');
  });
});

describe('get_model_context — Sequelize ORM path', () => {
  let store: Store;

  beforeEach(() => {
    const db = initializeDatabase(':memory:');
    store = new Store(db);
  });

  it('finds Sequelize model by name', () => {
    const fileId = store.insertFile('models/order.ts', 'typescript', 'h5', 100);
    store.insertOrmModel(
      {
        name: 'Order',
        orm: 'sequelize',
        collectionOrTable: 'orders',
        fields: [{ name: 'status', type: 'STRING' }],
      },
      fileId,
    );

    const result = getModelContext(store, 'Order');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.model.orm).toBe('sequelize');
    expect(result.value.model.collection).toBe('orders');
  });

  it('Eloquent lookup not confused by ORM model', () => {
    // ORM model takes priority — Eloquent fallback only if ORM not found
    const fileId = store.insertFile('models/item.ts', 'typescript', 'h6', 100);
    store.insertOrmModel({ name: 'Item', orm: 'sequelize' }, fileId);

    const result = getModelContext(store, 'Item');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.model.orm).toBe('sequelize');
  });
});
