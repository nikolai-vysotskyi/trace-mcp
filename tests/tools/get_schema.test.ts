import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php.js';
import { LaravelPlugin } from '../../src/indexer/plugins/framework/laravel/index.js';
import { getSchema } from '../../src/tools/schema.js';
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

describe('get_schema', () => {
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
