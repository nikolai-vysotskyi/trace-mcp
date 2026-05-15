/**
 * Behavioural coverage for the `verify_index` MCP tool.
 *
 * IMPL NOTE: `verify_index` is inline-registered in
 * `src/tools/register/core.ts` and forwards to `verifyIndex(store.db)`.
 * We assert the underlying contract (same approach as
 * `get-env-vars.behavioural.test.ts`).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { verifyIndex } from '../../../src/db/verify.js';

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

describe('verify_index (verifyIndex) — behavioural contract', () => {
  it('healthy DB returns ok=true with no suggested_repair on any check', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    db.prepare('INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      1,
      f32Buf([0.1, 0.2, 0.3, 0.4]),
    );
    const report = verifyIndex(db);
    expect(report.ok).toBe(true);
    expect(report.status).toBe('ok');
    for (const c of report.checks) {
      expect(c.suggested_repair).toBeUndefined();
    }
  });

  it('every check carries { name, status, detail } at minimum', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    const report = verifyIndex(db);
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(0);
    for (const c of report.checks) {
      expect(typeof c.name).toBe('string');
      expect(['ok', 'warn', 'error']).toContain(c.status);
      expect(typeof c.detail).toBe('string');
    }
  });

  it('orphan embeddings → suggested_repair = "drop-orphans"', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    // Embedding for symbol 1 + orphan for non-existent symbol 99.
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
    expect(orphan?.suggested_repair).toBe('drop-orphans');
    expect(orphan?.count).toBe(1);
  });

  it('FTS5 integrity check runs and reports ok on a clean index', () => {
    const db = new Database(':memory:');
    bootstrapMinimalIndex(db);
    const report = verifyIndex(db);
    const fts = report.checks.find((c) => c.name === 'fts_integrity');
    expect(fts).toBeDefined();
    expect(fts?.status).toBe('ok');
  });

  it('empty / unprovisioned DB returns clear envelope flagging missing tables', () => {
    const db = new Database(':memory:');
    // Intentionally empty — no schema at all.
    const report = verifyIndex(db);
    expect(report.ok).toBe(false);
    expect(['warn', 'error']).toContain(report.status);
    const req = report.checks.find((c) => c.name === 'required_tables');
    expect(req?.status).toBe('error');
    expect(req?.detail).toMatch(/Missing tables/);
  });
});
