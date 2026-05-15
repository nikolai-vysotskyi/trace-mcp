/**
 * Behavioural coverage for `getModelContext()` (the `get_model_context`
 * MCP tool). Exercises both code paths: ORM (Mongoose/Sequelize via
 * orm_models + orm_associations) and Eloquent-style (class symbol +
 * has_many/belongs_to edges + migrations).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../../src/db/store.js';
import { getModelContext } from '../../../src/tools/framework/model.js';
import { createTestStore } from '../../test-utils.js';

interface Fixture {
  store: Store;
}

function seed(): Fixture {
  const store = createTestStore();

  // --- Eloquent: User has_many Post (symbol-edge path) ---
  const userFileId = store.insertFile('app/Models/User.php', 'php', 'h-user', 300);
  const userSymDb = store.insertSymbol(userFileId, {
    symbolId: 'app/Models/User.php::App\\Models\\User#class',
    name: 'User',
    kind: 'class',
    fqn: 'App\\Models\\User',
    byteStart: 0,
    byteEnd: 200,
    lineStart: 1,
    lineEnd: 30,
  });
  const postFileId = store.insertFile('app/Models/Post.php', 'php', 'h-post', 300);
  const postSymDb = store.insertSymbol(postFileId, {
    symbolId: 'app/Models/Post.php::App\\Models\\Post#class',
    name: 'Post',
    kind: 'class',
    fqn: 'App\\Models\\Post',
    byteStart: 0,
    byteEnd: 150,
    lineStart: 1,
    lineEnd: 20,
  });

  const userNid = store.getNodeId('symbol', userSymDb);
  const postNid = store.getNodeId('symbol', postSymDb);
  if (userNid != null && postNid != null) {
    store.insertEdge(
      userNid,
      postNid,
      'has_many',
      true,
      { method: 'posts' },
      false,
      'ast_resolved',
    );
  }

  // Migration for `users` so schema is populated.
  const migrationsFileId = store.insertFile(
    'database/migrations/2024_create_users.php',
    'php',
    'h-mig',
    100,
  );
  store.insertMigration(
    {
      tableName: 'users',
      operation: 'create',
      columns: [
        { name: 'id', type: 'bigint', primary: true },
        { name: 'email', type: 'string', unique: true },
        { name: 'name', type: 'string', nullable: true },
      ],
      timestamp: '2024_01_01_000000',
    },
    migrationsFileId,
  );

  // --- ORM: Mongoose Author hasMany Book ---
  const authorFileId = store.insertFile('models/author.ts', 'typescript', 'h-author', 200);
  const authorOrmId = store.insertOrmModel(
    {
      name: 'Author',
      orm: 'mongoose',
      collectionOrTable: 'authors',
      fields: [
        { name: 'name', type: 'String' },
        { name: 'email', type: 'String' },
      ],
      metadata: { virtuals: ['displayName'] },
    },
    authorFileId,
  );
  const bookFileId = store.insertFile('models/book.ts', 'typescript', 'h-book', 200);
  const bookOrmId = store.insertOrmModel(
    {
      name: 'Book',
      orm: 'mongoose',
      collectionOrTable: 'books',
      fields: [{ name: 'title', type: 'String' }],
    },
    bookFileId,
  );
  store.insertOrmAssociation(authorOrmId, bookOrmId, 'Book', 'hasMany');

  return { store };
}

describe('getModelContext() — behavioural contract', () => {
  let ctx: Fixture;

  beforeEach(() => {
    ctx = seed();
  });

  it('Eloquent path returns model identity + filePath + symbolId', () => {
    const result = getModelContext(ctx.store, 'User');
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.model.name).toBe('User');
    expect(out.model.fqn).toBe('App\\Models\\User');
    expect(out.model.symbolId).toBe('app/Models/User.php::App\\Models\\User#class');
    expect(out.model.filePath).toBe('app/Models/User.php');
  });

  it('Eloquent path returns has_many relationship with type + relatedModel', () => {
    const result = getModelContext(ctx.store, 'User');
    expect(result.isOk()).toBe(true);
    const rels = result._unsafeUnwrap().relationships;
    expect(rels.length).toBeGreaterThan(0);
    const hasMany = rels.find((r) => r.type === 'has_many');
    expect(hasMany).toBeDefined();
    expect(hasMany!.relatedModel).toBe('App\\Models\\Post');
    expect(hasMany!.method).toBe('posts');
  });

  it('Eloquent path includes migration schema (table + columns)', () => {
    const result = getModelContext(ctx.store, 'User');
    expect(result.isOk()).toBe(true);
    const schema = result._unsafeUnwrap().schema;
    expect(schema.length).toBeGreaterThan(0);
    expect(schema[0].tableName).toBe('users');
    const colNames = (schema[0].columns as { name: string }[]).map((c) => c.name);
    expect(colNames).toEqual(expect.arrayContaining(['id', 'email', 'name']));
  });

  it('ORM path returns mongoose model with collection + ormMetadata', () => {
    const result = getModelContext(ctx.store, 'Author');
    expect(result.isOk()).toBe(true);
    const out = result._unsafeUnwrap();
    expect(out.model.orm).toBe('mongoose');
    expect(out.model.collection).toBe('authors');
    expect(out.model.symbolId).toBe('orm:Author');
    expect(out.ormMetadata).toBeDefined();
  });

  it('ORM associations surface as relationships with kind + target', () => {
    const result = getModelContext(ctx.store, 'Author');
    expect(result.isOk()).toBe(true);
    const rels = result._unsafeUnwrap().relationships;
    expect(rels.length).toBe(1);
    expect(rels[0].type).toBe('hasMany');
    expect(rels[0].relatedModel).toBe('Book');
  });

  it('unknown model surfaces NOT_FOUND error', () => {
    const result = getModelContext(ctx.store, 'NoSuchModel');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });
});
