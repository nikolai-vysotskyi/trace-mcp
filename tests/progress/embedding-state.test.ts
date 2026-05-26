import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { ProgressState } from '../../src/progress.js';

/**
 * The user-facing get_index_health used to report
 *   embedding: { phase: 'completed', processed: 0, total: 3936, percentage: 0 }
 * after the embedding provider was disabled mid-flight. A "completion" with
 * 0% done is incoherent — surface it as 'skipped' so consumers don't paint a
 * green checkmark on what's really an opted-out pipeline.
 */
describe('PipelineProgress — snapOne phase normalization', () => {
  test("'completed' with processed=0 / total>0 is surfaced as 'skipped'", () => {
    const state = new ProgressState();
    state.update('embedding', {
      phase: 'completed',
      processed: 0,
      total: 3936,
      startedAt: 1000,
      completedAt: 2000,
    });
    const snap = state.snapshot();
    expect(snap.embedding.phase).toBe('skipped');
    expect(snap.embedding.processed).toBe(0);
    expect(snap.embedding.total).toBe(3936);
    expect(snap.embedding.percentage).toBe(0);
  });

  test("'completed' with processed>0 keeps 'completed'", () => {
    const state = new ProgressState();
    state.update('embedding', {
      phase: 'completed',
      processed: 100,
      total: 100,
      startedAt: 1000,
      completedAt: 2000,
    });
    const snap = state.snapshot();
    expect(snap.embedding.phase).toBe('completed');
  });

  test("'idle' stays 'idle' regardless of counts", () => {
    const state = new ProgressState();
    const snap = state.snapshot();
    expect(snap.indexing.phase).toBe('idle');
    expect(snap.embedding.phase).toBe('idle');
  });

  test("'running' stays 'running'", () => {
    const state = new ProgressState();
    state.update('indexing', {
      phase: 'running',
      processed: 50,
      total: 100,
      startedAt: 1000,
      completedAt: 0,
    });
    const snap = state.snapshot();
    expect(snap.indexing.phase).toBe('running');
  });
});

describe('verifyIndex — embedding_dim backfill', () => {
  test('infers embedding_meta.dim from uniform-length rows when meta is missing', async () => {
    const { verifyIndex } = await import('../../src/db/verify.js');
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE symbol_embeddings (
        symbol_id INTEGER PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (symbol_id) REFERENCES symbols(id)
      );
      CREATE TABLE embedding_meta (id INTEGER PRIMARY KEY, dim INTEGER);
    `);
    // 384-dimensional Float32 → 1536 bytes per row
    const dim = 384;
    const bytes = Buffer.alloc(dim * 4);
    const insertSym = db.prepare('INSERT INTO symbols (name) VALUES (?)');
    const insertEmb = db.prepare(
      'INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)',
    );
    for (let i = 0; i < 3; i++) {
      const r = insertSym.run(`sym_${i}`);
      insertEmb.run(Number(r.lastInsertRowid), bytes);
    }
    // embedding_meta deliberately empty — simulates the dim-missing state the
    // user hit after provider migration.

    const report = verifyIndex(db);
    const check = report.checks.find((c) => c.name === 'embedding_dim')!;
    expect(check).toBeDefined();
    expect(check.status).toBe('ok');
    expect(check.detail).toMatch(/Inferred dim=384/);

    // And the meta row should now exist for next run
    const meta = db.prepare('SELECT dim FROM embedding_meta WHERE id = 1').get() as
      | { dim: number }
      | undefined;
    expect(meta?.dim).toBe(384);
  });

  test('keeps warn when row lengths are heterogeneous (cannot infer)', async () => {
    const { verifyIndex } = await import('../../src/db/verify.js');
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE symbols (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE symbol_embeddings (
        symbol_id INTEGER PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (symbol_id) REFERENCES symbols(id)
      );
      CREATE TABLE embedding_meta (id INTEGER PRIMARY KEY, dim INTEGER);
    `);
    const insertSym = db.prepare('INSERT INTO symbols (name) VALUES (?)');
    const insertEmb = db.prepare(
      'INSERT INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)',
    );
    const r1 = insertSym.run('a');
    insertEmb.run(Number(r1.lastInsertRowid), Buffer.alloc(1536));
    const r2 = insertSym.run('b');
    insertEmb.run(Number(r2.lastInsertRowid), Buffer.alloc(3072));

    const report = verifyIndex(db);
    const check = report.checks.find((c) => c.name === 'embedding_dim')!;
    expect(check.status).toBe('warn');
    expect(check.detail).toMatch(/distinct byte lengths/);
  });
});
