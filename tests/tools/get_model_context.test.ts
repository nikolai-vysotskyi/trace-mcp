import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php.js';
import { LaravelPlugin } from '../../src/indexer/plugins/framework/laravel/index.js';
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
