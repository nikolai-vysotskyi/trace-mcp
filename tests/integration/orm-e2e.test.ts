/**
 * Integration: Mongoose and Sequelize ORM plugins through full pipeline.
 * Verifies model extraction, association storage, and graph edge creation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { MongoosePlugin } from '../../src/indexer/plugins/integration/orm/mongoose/index.js';
import { SequelizePlugin } from '../../src/indexer/plugins/integration/orm/sequelize/index.js';
import { getSchema } from '../../src/tools/framework/schema.js';

describe('Mongoose ORM e2e', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/mongoose-8');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();

    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new MongoosePlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.ts'],
      exclude: ['node_modules/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('indexes mongoose model files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts ORM models', () => {
    const models = store.getAllOrmModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
    const names = models.map((m) => m.name);
    expect(names).toContain('User');
    expect(names).toContain('Post');
  });

  it('stores model with correct orm type', () => {
    const models = store.getOrmModelsByOrm('mongoose');
    expect(models.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts associations (refs)', () => {
    const userModel = store.getOrmModelByName('User');
    expect(userModel).toBeDefined();
    const assocs = store.getOrmAssociationsByModel(userModel!.id);
    // User has refs to Post and Profile
    expect(assocs.length).toBeGreaterThan(0);
    const targetNames = assocs.map((a) => a.target_model_name);
    expect(targetNames).toContain('Post');
  });

  it('creates mongoose_references edges in graph', () => {
    const edges = store.getEdgesByType('mongoose_references');
    // User->Post and Post->User refs
    expect(edges.length).toBeGreaterThan(0);
  });

  it('get_schema returns ORM schemas', () => {
    const result = getSchema(store, 'User');
    expect(result.isOk()).toBe(true);
    const { ormSchemas } = result._unsafeUnwrap();
    expect(ormSchemas).toBeDefined();
    expect(ormSchemas!.length).toBe(1);
    expect(ormSchemas![0].orm).toBe('mongoose');
    expect(ormSchemas![0].collection).toBe('users');
  });
});

describe('Sequelize ORM e2e', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/sequelize-6');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();

    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new SequelizePlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.ts'],
      exclude: ['node_modules/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('extracts Sequelize models', () => {
    const models = store.getAllOrmModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
    const names = models.map((m) => m.name);
    expect(names).toContain('User');
    expect(names).toContain('Post');
  });

  it('stores model with correct orm type', () => {
    const models = store.getOrmModelsByOrm('sequelize');
    expect(models.length).toBeGreaterThanOrEqual(2);
  });

  it('extracts associations', () => {
    const userModel = store.getOrmModelByName('User');
    expect(userModel).toBeDefined();
    const assocs = store.getOrmAssociationsByModel(userModel!.id);
    // User hasMany Post, belongsTo Role, belongsToMany Project, hasOne Profile
    expect(assocs.length).toBeGreaterThanOrEqual(3);
  });

  it('creates sequelize association edges in graph', () => {
    // User hasMany Post — only works if Post model exists in DB
    const hasManyEdges = store.getEdgesByType('sequelize_has_many');
    const belongsToEdges = store.getEdgesByType('sequelize_belongs_to');
    // At minimum Post.belongsTo(User) should create an edge
    const totalEdges = hasManyEdges.length + belongsToEdges.length;
    expect(totalEdges).toBeGreaterThan(0);
  });

  it('extracts migration table structure as ORM model', () => {
    // Sequelize stores migration createTable as ORM models (not migrations table)
    const allModels = store.getAllOrmModels();
    const migrationModel = allModels.find(
      (m) => m.name === 'users' && m.metadata?.includes('migration'),
    );
    expect(migrationModel).toBeDefined();
  });
});
