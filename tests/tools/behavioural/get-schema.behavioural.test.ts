/**
 * Behavioural coverage for `getSchema()` (the `get_schema` MCP tool).
 *
 * Two paths under one fixture:
 *   - SQL migrations (create-then-alter) reconstructed into a column map.
 *   - ORM (mongoose) model surfaced via ormSchemas.
 * Asserts column shape (name/type/nullable/primary/unique), the "all tables"
 * variant, and the empty result for unknown tables.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getSchema } from '../../../src/tools/framework/schema.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

function seed(): Fixture {
  const store = createTestStore();

  const migrationsFileId = store.insertFile(
    'database/migrations/2024_create_users.php',
    'php',
    'h-mig-1',
    100,
  );
  store.insertMigration(
    {
      tableName: 'users',
      operation: 'create',
      columns: [
        { name: 'id', type: 'bigint', primary: true, autoIncrement: true },
        { name: 'email', type: 'string', unique: true },
        { name: 'name', type: 'string', nullable: true },
      ],
      timestamp: '2024_01_01_000000',
    },
    migrationsFileId,
  );

  // Alter migration: add a `created_at` column.
  const alterFileId = store.insertFile(
    'database/migrations/2024_alter_users.php',
    'php',
    'h-mig-2',
    100,
  );
  store.insertMigration(
    {
      tableName: 'users',
      operation: 'alter',
      columns: [{ name: 'created_at', type: 'datetime', nullable: true }],
      timestamp: '2024_02_01_000000',
    },
    alterFileId,
  );

  // Independent posts table.
  const postsMigFileId = store.insertFile(
    'database/migrations/2024_create_posts.php',
    'php',
    'h-mig-3',
    100,
  );
  store.insertMigration(
    {
      tableName: 'posts',
      operation: 'create',
      columns: [
        { name: 'id', type: 'bigint', primary: true },
        { name: 'title', type: 'string' },
      ],
      timestamp: '2024_03_01_000000',
    },
    postsMigFileId,
  );

  // ORM model (mongoose) — surfaces via ormSchemas.
  const ormFileId = store.insertFile('models/article.ts', 'typescript', 'h-orm', 200);
  store.insertOrmModel(
    {
      name: 'Article',
      orm: 'mongoose',
      collectionOrTable: 'articles',
      fields: [
        { name: 'title', type: 'String', required: true },
        { name: 'slug', type: 'String' },
      ],
      metadata: { indexes: [{ fields: { slug: 1 }, unique: true }] },
    },
    ormFileId,
  );

  return { store };
}

describe('getSchema() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('reconstructs a single table by name from create + alter migrations', () => {
    const result = getSchema(ctx.store, 'users');
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.tables.length).toBe(1);
    const usersTable = out.tables[0];
    expect(usersTable.tableName).toBe('users');
    const colNames = usersTable.columns.map((c) => c.name);
    // create + alter must both be applied.
    expect(colNames).toEqual(expect.arrayContaining(['id', 'email', 'name', 'created_at']));
  });

  it('each column row carries name + type + optional flags', () => {
    const result = getSchema(ctx.store, 'users');
    expect(result.isOk()).toBe(true);
    const cols = result._unsafeUnwrap().tables[0].columns;
    const idCol = cols.find((c) => c.name === 'id')!;
    expect(idCol.type).toBe('bigint');
    expect(idCol.primary).toBe(true);
    expect(idCol.autoIncrement).toBe(true);

    const emailCol = cols.find((c) => c.name === 'email')!;
    expect(emailCol.unique).toBe(true);

    const nameCol = cols.find((c) => c.name === 'name')!;
    expect(nameCol.nullable).toBe(true);
  });

  it('all-tables variant returns every migrated table', () => {
    const result = getSchema(ctx.store);
    expect(result.isOk()).toBe(true);
    const names = result._unsafeUnwrap().tables.map((t) => t.tableName);
    expect(names).toEqual(expect.arrayContaining(['users', 'posts']));
  });

  it('all-tables variant surfaces ormSchemas with fields + indexes', () => {
    const result = getSchema(ctx.store);
    expect(result.isOk()).toBe(true);
    const orm = result._unsafeUnwrap().ormSchemas;
    expect(orm).toBeDefined();
    const article = orm!.find((s) => s.name === 'Article')!;
    expect(article.orm).toBe('mongoose');
    expect(article.collection).toBe('articles');
    expect(article.fields.length).toBe(2);
    expect(article.indexes).toBeDefined();
  });

  it('unknown table name returns empty tables array (ok envelope, not error)', () => {
    const result = getSchema(ctx.store, 'no_such_table');
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.tables).toEqual([]);
    // No ormSchemas key either when nothing matches.
    expect(out.ormSchemas === undefined || out.ormSchemas.length === 0).toBe(true);
  });
});
