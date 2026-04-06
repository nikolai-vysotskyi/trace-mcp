import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore } from '../test-utils.js';
import { BlobVectorStore } from '../../src/ai/vector-store.js';
import type Database from 'better-sqlite3';

describe('BlobVectorStore', () => {
  let db: Database.Database;
  let store: BlobVectorStore;

  beforeEach(() => {
    db = createTestStore().db;
    // Insert a fake file and symbols so foreign keys work
    db.exec(`
      INSERT INTO files (id, path, language, indexed_at) VALUES (1, 'test.ts', 'ts', datetime('now'));
      INSERT INTO symbols (id, file_id, symbol_id, name, kind, byte_start, byte_end)
        VALUES (1, 1, 'sym-1', 'Foo', 'class', 0, 100);
      INSERT INTO symbols (id, file_id, symbol_id, name, kind, byte_start, byte_end)
        VALUES (2, 1, 'sym-2', 'Bar', 'class', 100, 200);
      INSERT INTO symbols (id, file_id, symbol_id, name, kind, byte_start, byte_end)
        VALUES (3, 1, 'sym-3', 'Baz', 'class', 200, 300);
    `);
    store = new BlobVectorStore(db);
  });

  it('inserts and retrieves embeddings', () => {
    store.insert(1, [1, 0, 0]);
    store.insert(2, [0, 1, 0]);
    expect(store.count()).toBe(2);
  });

  it('search returns correct ordering by cosine similarity', () => {
    // vec1 is close to query, vec2 is orthogonal, vec3 is opposite direction
    store.insert(1, [0.9, 0.1, 0]);
    store.insert(2, [0, 1, 0]);
    store.insert(3, [-1, 0, 0]);

    const results = store.search([1, 0, 0], 3);
    expect(results).toHaveLength(3);
    // sym-1 should rank first (most similar to [1,0,0])
    expect(results[0].id).toBe(1);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    // sym-3 should rank last (opposite direction)
    expect(results[2].id).toBe(3);
    expect(results[2].score).toBeLessThan(0);
  });

  it('search respects limit', () => {
    store.insert(1, [1, 0, 0]);
    store.insert(2, [0, 1, 0]);
    store.insert(3, [0, 0, 1]);

    const results = store.search([1, 0, 0], 1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(1);
  });

  it('delete removes embedding', () => {
    store.insert(1, [1, 0, 0]);
    expect(store.count()).toBe(1);
    store.delete(1);
    expect(store.count()).toBe(0);
  });

  it('returns empty for search on empty store', () => {
    const results = store.search([1, 0, 0], 5);
    expect(results).toEqual([]);
  });

  it('handles zero vector query gracefully', () => {
    store.insert(1, [1, 0, 0]);
    const results = store.search([0, 0, 0], 5);
    expect(results).toEqual([]);
  });

  it('insert or replace updates existing embedding', () => {
    store.insert(1, [1, 0, 0]);
    store.insert(1, [0, 1, 0]);
    expect(store.count()).toBe(1);

    const results = store.search([0, 1, 0], 1);
    expect(results[0].id).toBe(1);
    expect(results[0].score).toBeCloseTo(1.0, 5);
  });
});
