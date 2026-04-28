/**
 * Integration: get_schema reconstructs DB schema from migration files.
 * Runs the full pipeline on the laravel-10 fixture (2 migrations) and
 * verifies that getSchema returns correct table/column structure.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { getSchema } from '../../src/tools/framework/schema.js';
import { createTestStore } from '../test-utils.js';

describe('get_schema e2e', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/laravel-10');
    store = createTestStore();
    const registry = new PluginRegistry();

    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.php'],
      exclude: ['vendor/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('indexes migration files', () => {
    const migrations = store.getAllMigrations();
    // 2 migrations: create_users_table + create_posts_table
    expect(migrations.length).toBeGreaterThanOrEqual(2);
  });

  it('returns all tables when no filter', () => {
    const result = getSchema(store);
    expect(result.isOk()).toBe(true);
    const { tables } = result._unsafeUnwrap();
    const tableNames = tables.map((t) => t.tableName);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('posts');
  });

  it('reconstructs users table columns', () => {
    const result = getSchema(store, 'users');
    expect(result.isOk()).toBe(true);
    const { tables } = result._unsafeUnwrap();
    expect(tables.length).toBe(1);
    const { columns } = tables[0];

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('email');
    expect(colNames).toContain('password');

    const emailCol = columns.find((c) => c.name === 'email');
    expect(emailCol?.unique).toBe(true);
  });

  it('reconstructs posts table with foreign key', () => {
    const result = getSchema(store, 'posts');
    expect(result.isOk()).toBe(true);
    const { tables } = result._unsafeUnwrap();
    expect(tables.length).toBe(1);
    const { columns } = tables[0];

    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('title');
    expect(colNames).toContain('body');

    const userIdCol = columns.find((c) => c.name === 'user_id');
    expect(userIdCol?.foreign).toBe(true);
  });

  it('includes chronological operation history', () => {
    const result = getSchema(store, 'users');
    expect(result.isOk()).toBe(true);
    const { tables } = result._unsafeUnwrap();
    const { operations } = tables[0];
    expect(operations.length).toBeGreaterThanOrEqual(1);
    expect(operations[0].operation).toBe('create');
  });

  it('returns empty for unknown table', () => {
    const result = getSchema(store, 'nonexistent_table');
    expect(result.isOk()).toBe(true);
    const { tables } = result._unsafeUnwrap();
    expect(tables.length).toBe(0);
  });
});
