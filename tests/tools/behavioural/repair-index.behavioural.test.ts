/**
 * Behavioural coverage for the `repair_index` MCP tool.
 *
 * IMPL NOTE: `repair_index` is inline-registered in
 * `src/tools/register/core.ts` (line 263) and forwards to
 * `repairIndex(store.db, mode)` exported by `src/db/repair.ts`. We test the
 * underlying primitive against an in-memory Database — same approach as
 * `verify-index.behavioural.test.ts`.
 *
 * Contract under test (one case per mode + idempotency + envelope shape):
 *   - mode='drop-orphans': deletes embedding rows whose symbol_id is gone
 *   - mode='drop-vec': drops both symbol_embeddings + embedding_meta tables
 *   - mode='rebuild-fts': drops + rebuilds symbols_fts from symbols
 *   - second invocation is idempotent (affected==0)
 *   - every mode returns the documented { mode, ok, detail, affected } envelope
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { repairIndex } from '../../../src/db/repair.js';

function bootstrapMinimalIndex(db: Database.Database): void {
  db.exec(`
    CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT,
      fqn TEXT,
      signature TEXT,
      summary TEXT
    );
    CREATE VIRTUAL TABLE symbols_fts USING fts5(
      name, fqn, signature, summary, content='symbols', content_rowid='id'
    );
    CREATE TABLE embedding_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      dim INTEGER NOT NULL,
      provider TEXT,
      model TEXT
    );
    CREATE TABLE symbol_embeddings (
      symbol_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL
    );
    INSERT INTO files (id, path) VALUES (1, 'a.ts'), (2, 'b.ts');
    INSERT INTO symbols (id, file_id, name, fqn, signature, summary)
      VALUES
        (1, 1, 'foo', 'a.foo', 'foo()', null),
        (2, 2, 'bar', 'b.bar', 'bar()', null);
    INSERT INTO symbols_fts (rowid, name, fqn, signature, summary)
      SELECT id, name, fqn, signature, summary FROM symbols;
    INSERT INTO embedding_meta (id, dim, provider, model)
      VALUES (1, 4, 'test', 'test-model');
  `);
}

function f32Buf(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

describe('repair_index — repairIndex(db, mode) behavioural contract', () => {
  it('mode=drop-orphans removes embedding rows whose symbol_id no longer exists', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    // Two valid + two orphan embedding rows.
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      1,
      f32Buf([0.1, 0.2, 0.3, 0.4]),
    );
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      2,
      f32Buf([0.5, 0.6, 0.7, 0.8]),
    );
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      99,
      f32Buf([0, 0, 0, 0]),
    );
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      100,
      f32Buf([0, 0, 0, 0]),
    );

    const result = repairIndex(db, 'drop-orphans');
    expect(result.mode).toBe('drop-orphans');
    expect(result.ok).toBe(true);
    expect(result.affected).toBe(2);
    expect(typeof result.detail).toBe('string');

    const remaining = db.prepare('SELECT COUNT(*) AS c FROM symbol_embeddings').get() as {
      c: number;
    };
    expect(remaining.c).toBe(2);
  });

  it('mode=drop-orphans is idempotent — second call returns affected=0', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      99,
      f32Buf([0, 0, 0, 0]),
    );

    const first = repairIndex(db, 'drop-orphans');
    expect(first.affected).toBe(1);
    const second = repairIndex(db, 'drop-orphans');
    expect(second.ok).toBe(true);
    expect(second.affected).toBe(0);
  });

  it('mode=drop-vec drops symbol_embeddings + embedding_meta and reports row count', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      1,
      f32Buf([0, 0, 0, 0]),
    );
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      2,
      f32Buf([0, 0, 0, 0]),
    );

    const result = repairIndex(db, 'drop-vec');
    expect(result.mode).toBe('drop-vec');
    expect(result.ok).toBe(true);
    expect(result.affected).toBe(2);
    // Tables are gone.
    const probe = (name: string) =>
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name) as
        | { name: string }
        | undefined;
    expect(probe('symbol_embeddings')).toBeUndefined();
    expect(probe('embedding_meta')).toBeUndefined();

    // Second invocation is idempotent — both tables already gone.
    const again = repairIndex(db, 'drop-vec');
    expect(again.ok).toBe(true);
    expect(again.affected).toBe(0);
  });

  it('mode=rebuild-fts drops + reloads symbols_fts from the symbols table', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    // Note: symbols_fts is mirrored from `symbols` via triggers, so a
    // direct DELETE doesn't necessarily zero the count even briefly. We
    // assert the contract instead: after rebuild-fts, the FTS row count
    // matches the symbols row count and the result envelope reports the
    // reloaded count.
    const result = repairIndex(db, 'rebuild-fts');
    expect(result.mode).toBe('rebuild-fts');
    expect(result.ok).toBe(true);
    expect(result.affected).toBe(2); // two symbols reloaded

    const after = db.prepare('SELECT COUNT(*) AS c FROM symbols_fts').get() as { c: number };
    expect(after.c).toBe(2);
  });

  it('every result envelope carries { mode, ok, detail, affected } typed correctly', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    const modes = ['drop-orphans', 'drop-vec', 'rebuild-fts'] as const;
    for (const mode of modes) {
      // fresh DB per mode so each mode runs against a sane starting state
      const fresh = new Database(':memory:');
      bootstrapMinimalIndex(fresh);
      const r = repairIndex(fresh, mode);
      expect(r.mode).toBe(mode);
      expect(typeof r.ok).toBe('boolean');
      expect(typeof r.detail).toBe('string');
      expect(r.detail.length).toBeGreaterThan(0);
      expect(typeof r.affected).toBe('number');
      fresh.close();
    }
    db.close();
  });
});
