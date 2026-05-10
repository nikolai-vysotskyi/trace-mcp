import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { repairIndex } from '../../src/db/repair.js';
import { verifyIndex } from '../../src/db/verify.js';

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
    CREATE TABLE nodes (id INTEGER PRIMARY KEY, kind TEXT, ref_id INTEGER);
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY,
      source_node_id INTEGER NOT NULL,
      target_node_id INTEGER NOT NULL,
      edge_type_id INTEGER NOT NULL
    );
    CREATE TABLE edge_types (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE VIRTUAL TABLE symbols_fts USING fts5(name, fqn, signature, summary, content='symbols', content_rowid='id');
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
    INSERT INTO files (id, path) VALUES (1, 'a.ts');
    INSERT INTO symbols (id, file_id, name, fqn, signature, summary)
      VALUES (1, 1, 'foo', 'a.foo', 'foo()', null);
    INSERT INTO symbols_fts (rowid, name, fqn, signature, summary)
      SELECT id, name, fqn, signature, summary FROM symbols;
    INSERT INTO embedding_meta (id, dim, provider, model)
      VALUES (1, 4, 'test', 'test-model');
  `);
}

function f32Buf(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

describe('verifyIndex', () => {
  it('reports ok on a minimal healthy index', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      1,
      f32Buf([0.1, 0.2, 0.3, 0.4]),
    );
    const report = verifyIndex(db);
    expect(report.ok).toBe(true);
    expect(report.status).toBe('ok');
    const names = report.checks.map((c) => c.name);
    expect(names).toContain('sqlite_integrity');
    expect(names).toContain('foreign_keys');
    expect(names).toContain('required_tables');
    expect(names).toContain('embedding_dim');
    expect(names).toContain('orphan_embeddings');
    expect(names).toContain('fts_integrity');
  });

  it('flags orphan embeddings and suggests drop-orphans', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    // Embedding for symbol 1 + an orphan for symbol 99
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      1,
      f32Buf([0, 0, 0, 0]),
    );
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      99,
      f32Buf([0, 0, 0, 0]),
    );
    const report = verifyIndex(db);
    const orphan = report.checks.find((c) => c.name === 'orphan_embeddings');
    expect(orphan?.status).toBe('warn');
    expect(orphan?.count).toBe(1);
    expect(orphan?.suggested_repair).toBe('drop-orphans');
  });

  it('flags wrong-dimension embeddings and suggests drop-vec', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      1,
      f32Buf([0.1, 0.2, 0.3]), // 3 dims, not 4
    );
    const report = verifyIndex(db);
    const dim = report.checks.find((c) => c.name === 'embedding_dim');
    expect(dim?.status).toBe('error');
    expect(dim?.suggested_repair).toBe('drop-vec');
    expect(report.ok).toBe(false);
    expect(report.status).toBe('error');
  });

  it('passes the FTS5 integrity-check on a clean index', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    const report = verifyIndex(db);
    const fts = report.checks.find((c) => c.name === 'fts_integrity');
    expect(fts?.status).toBe('ok');
  });

  it('reports missing required tables as error', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT)');
    const report = verifyIndex(db);
    const req = report.checks.find((c) => c.name === 'required_tables');
    expect(req?.status).toBe('error');
    expect(req?.detail).toMatch(/Missing tables/);
  });
});

describe('repairIndex', () => {
  it('drop-orphans removes only the unreferenced rows', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      1,
      f32Buf([0, 0, 0, 0]),
    );
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      42,
      f32Buf([0, 0, 0, 0]),
    );
    const result = repairIndex(db, 'drop-orphans');
    expect(result.ok).toBe(true);
    expect(result.affected).toBe(1);
    const remaining = db
      .prepare('SELECT symbol_id FROM symbol_embeddings ORDER BY symbol_id')
      .all() as { symbol_id: number }[];
    expect(remaining.map((r) => r.symbol_id)).toEqual([1]);
  });

  it('drop-orphans is a no-op on a clean index', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      1,
      f32Buf([0, 0, 0, 0]),
    );
    const result = repairIndex(db, 'drop-orphans');
    expect(result.affected).toBe(0);
  });

  it('drop-vec removes both vector tables', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      1,
      f32Buf([0, 0, 0, 0]),
    );
    const result = repairIndex(db, 'drop-vec');
    expect(result.ok).toBe(true);
    expect(result.affected).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='symbol_embeddings'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='embedding_meta'").get(),
    ).toBeUndefined();
  });

  it('rebuild-fts restores parity between symbols and symbols_fts', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    for (let i = 2; i <= 10; i++) {
      db.prepare(
        'INSERT INTO symbols (id, file_id, name, fqn, signature) VALUES (?, ?, ?, ?, ?)',
      ).run(i, 1, `s${i}`, `a.s${i}`, '()');
    }
    // FTS still has 1 row — drift!
    let r = repairIndex(db, 'rebuild-fts');
    expect(r.ok).toBe(true);
    expect(r.affected).toBe(10);
    const ftsCount = (db.prepare('SELECT COUNT(*) AS c FROM symbols_fts').get() as { c: number }).c;
    expect(ftsCount).toBe(10);
  });

  it('rebuild-fts produces a table with the same column tuple as the bootstrap DDL', () => {
    // Regression: repair.ts used to copy-paste the FTS DDL. A future column
    // addition in schema.ts would silently leave repair creating the old
    // schema. Both paths now share createSymbolsFtsTable — verify that the
    // column shape after rebuild-fts matches what was created at bootstrap.
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    const before = db.prepare('PRAGMA table_info(symbols_fts)').all() as { name: string }[];
    repairIndex(db, 'rebuild-fts');
    const after = db.prepare('PRAGMA table_info(symbols_fts)').all() as { name: string }[];
    expect(after.map((c) => c.name)).toEqual(before.map((c) => c.name));
    expect(after.map((c) => c.name)).toEqual(['name', 'fqn', 'signature', 'summary']);
  });
});
