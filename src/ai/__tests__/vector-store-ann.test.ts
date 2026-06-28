import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { Vec0Index } from '../vec-extension.js';
import { BlobVectorStore } from '../vector-store.js';

// Is sqlite-vec actually installed + loadable here? It is an optionalDependency,
// so CI/offline runs the brute-force path. The correctness tests below assert on
// whichever path is active; the last test is gated on the extension being present.
const annAvailable = (() => {
  const db = new Database(':memory:');
  const ok = Vec0Index.tryCreate(db) !== null;
  db.close();
  return ok;
})();

function freshStore(dim: number): BlobVectorStore {
  // symbol_embeddings FKs symbols(id); these unit tests exercise only the vector
  // store, so disable FK enforcement instead of standing up a real symbols table.
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  const store = new BlobVectorStore(db);
  store.setMeta('test-model', dim, 'test');
  return store;
}

describe('BlobVectorStore vector search (ANN + brute-force parity)', () => {
  it('returns nearest neighbours by cosine, sorted by descending score', () => {
    const store = freshStore(3);
    store.insert(1, [1, 0, 0]);
    store.insert(2, [0, 1, 0]);
    store.insert(3, [0.9, 0.1, 0]); // near-parallel to vector 1

    const res = store.search([1, 0, 0], 2);
    expect(res.map((r) => r.id)).toEqual([1, 3]);
    expect(res[0].score).toBeGreaterThan(res[1].score);
    expect(res[0].score).toBeCloseTo(1, 4); // identical direction → cosine ≈ 1
  });

  it('brute-force fallback returns identical results when the ANN index is unavailable', () => {
    // sqlite-vec is an optionalDependency that is usually present (incl. CI), so the
    // ANN path otherwise shadows brute-force everywhere. Force vec to null to keep
    // the fallback covered regardless of whether the extension is installed.
    const store = freshStore(3);
    (store as unknown as { vec: null }).vec = null;
    store.insert(1, [1, 0, 0]);
    store.insert(2, [0, 1, 0]);
    store.insert(3, [0.9, 0.1, 0]);

    const res = store.search([1, 0, 0], 2);
    expect(res.map((r) => r.id)).toEqual([1, 3]);
    expect(res[0].score).toBeCloseTo(1, 4);
  });

  it('reflects delete and clear in subsequent searches', () => {
    const store = freshStore(3);
    store.insert(1, [1, 0, 0]);
    store.insert(2, [0, 1, 0]);

    store.delete(1);
    expect(store.search([1, 0, 0], 5).find((r) => r.id === 1)).toBeUndefined();

    store.clear();
    expect(store.search([0, 1, 0], 5)).toEqual([]);
  });

  it('survives re-embedding at a different dimensionality after clear()', () => {
    const store = freshStore(3);
    store.insert(1, [1, 0, 0]);
    store.clear();
    // New embedding space, larger dim — must not throw and must search correctly.
    store.setMeta('test-model-2', 4, 'test');
    store.insert(10, [1, 0, 0, 0]);
    store.insert(11, [0, 0, 0, 1]);
    expect(store.search([1, 0, 0, 0], 1)[0].id).toBe(10);
  });

  it.skipIf(!annAvailable)(
    'actually populates and queries the vec0 ANN index when sqlite-vec is present',
    () => {
      const store = freshStore(4);
      const vecs: number[][] = [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0.8, 0.2, 0, 0],
        [0, 0, 1, 0],
      ];
      vecs.forEach((v, i) => store.insert(i + 1, v));

      // The accelerator table exists and mirrors every BLOB row.
      const db = (store as unknown as { db: Database.Database }).db;
      const cnt = db.prepare('SELECT COUNT(*) AS c FROM vec_symbol_embeddings').get() as {
        c: number;
      };
      expect(cnt.c).toBe(4);

      expect(store.search([1, 0, 0, 0], 1)[0].id).toBe(1);
    },
  );

  it.skipIf(!annAvailable)('backfills the vec0 index from a pre-existing BLOB table', () => {
    // Simulate an index built before the ANN feature: write BLOB rows directly,
    // then open a fresh store over the same db and confirm it backfills vec0.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    const pre = new BlobVectorStore(db);
    pre.setMeta('test-model', 3, 'test');
    // Bypass the accelerator by writing straight to the BLOB table.
    const buf = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
    db.prepare('DROP TABLE IF EXISTS vec_symbol_embeddings').run();
    db.prepare('INSERT OR REPLACE INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      1,
      buf([1, 0, 0]),
    );
    db.prepare('INSERT OR REPLACE INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)').run(
      2,
      buf([0, 1, 0]),
    );

    const reopened = new BlobVectorStore(db);
    const cnt = db.prepare('SELECT COUNT(*) AS c FROM vec_symbol_embeddings').get() as {
      c: number;
    };
    expect(cnt.c).toBe(2);
    expect(reopened.search([1, 0, 0], 1)[0].id).toBe(1);
  });
});
