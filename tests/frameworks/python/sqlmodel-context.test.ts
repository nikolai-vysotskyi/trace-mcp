/**
 * Regression: get_model_context must return real schema (fields) and
 * relationships for Python SQLModel / Pydantic / SQLAlchemy models. Previously
 * Python models fell through to the Eloquent path and returned empty
 * schema/relationships, making the tool useless for FastAPI+SQLModel stacks.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { IndexingPipeline } from '../../../src/indexer/pipeline.js';
import { PythonLanguagePlugin } from '../../../src/indexer/plugins/language/python/index.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { getModelContext } from '../../../src/tools/framework/model.js';
import { createTestStore, createTmpDir, removeTmpDir, writeFixtureFile } from '../../test-utils.js';

describe('get_model_context for SQLModel', () => {
  let store: Store;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = createTmpDir('trace-mcp-sqlmodel-');
    writeFixtureFile(
      tmpDir,
      'models.py',
      [
        'from sqlmodel import SQLModel, Field, Relationship',
        'from typing import Optional, List',
        '',
        'class User(SQLModel, table=True):',
        '    id: Optional[int] = Field(default=None, primary_key=True)',
        '    email: str = Field(index=True, unique=True)',
        '    full_name: str',
        '    orders: List["Order"] = Relationship(back_populates="user")',
        '',
        'class Order(SQLModel, table=True):',
        '    id: Optional[int] = Field(default=None, primary_key=True)',
        '    user_id: int = Field(foreign_key="user.id")',
        '    total: float',
        '    user: Optional[User] = Relationship(back_populates="orders")',
      ].join('\n'),
    );

    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PythonLanguagePlugin());
    const config = {
      root: tmpDir,
      include: ['**/*.py'],
      exclude: [],
      db: { path: ':memory:' },
      plugins: [],
    } as never;
    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);
  });

  afterAll(() => removeTmpDir(tmpDir));

  it('returns the model fields as schema columns', () => {
    const res = getModelContext(store, 'User');
    expect(res.isOk()).toBe(true);
    const ctx = res._unsafeUnwrap();

    expect(ctx.model.orm).toBe('sqlmodel');
    expect(ctx.schema.length).toBeGreaterThan(0);
    const columnNames = ctx.schema[0].columns.map((c) => (c as { name: string }).name);
    expect(columnNames).toEqual(expect.arrayContaining(['id', 'email', 'full_name', 'orders']));
  });

  it('surfaces related models via type-reference edges', () => {
    const res = getModelContext(store, 'User');
    const ctx = res._unsafeUnwrap();
    const related = ctx.relationships.map((r) => r.relatedModel);
    // User <-> Order are linked through Relationship/annotation type references.
    expect(related.some((r) => r.endsWith('Order'))).toBe(true);
  });

  it('works symmetrically from the Order side', () => {
    const res = getModelContext(store, 'Order');
    expect(res.isOk()).toBe(true);
    const ctx = res._unsafeUnwrap();
    expect(ctx.schema[0].columns.map((c) => (c as { name: string }).name)).toEqual(
      expect.arrayContaining(['user_id', 'total', 'user']),
    );
    expect(ctx.relationships.map((r) => r.relatedModel).some((r) => r.endsWith('User'))).toBe(true);
  });
});
