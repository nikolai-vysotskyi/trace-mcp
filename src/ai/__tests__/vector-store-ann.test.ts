import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { Vec0Index } from '../vec-extension.js';
import { BlobVectorStore, shouldRebuildVecIndex } from '../vector-store.js';

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

  describe('vec0 orphan cleanup (GH#1447)', () => {
    function realDb(): { db: Database.Database; store: Store; vstore: BlobVectorStore } {
      const db = initializeDatabase(':memory:');
      const store = new Store(db);
      const vstore = new BlobVectorStore(db);
      vstore.setMeta('test-model', 3, 'test');
      return { db, store, vstore };
    }

    function addFile(
      store: Store,
      rel: string,
      names: string[],
    ): { fileId: number; ids: number[] } {
      const fileId = store.insertFile(rel, 'typescript', `hash-${rel}`, 10);
      const ids = store.insertSymbols(
        fileId,
        names.map((name) => ({
          name,
          kind: 'function' as const,
          symbolId: `${rel}::${name}#function`,
          byteStart: 0,
          byteEnd: 10,
        })),
      );
      return { fileId, ids };
    }

    const vecCount = (db: Database.Database) =>
      (db.prepare('SELECT COUNT(*) AS c FROM vec_symbol_embeddings').get() as { c: number }).c;

    it("deleteSymbolsByFile removes vec0 rows for the file's symbols", () => {
      const { db, store, vstore } = realDb();
      try {
        const { fileId, ids } = addFile(store, 'a.ts', ['foo', 'bar']);
        for (const id of ids) vstore.insert(id, [1, 0, 0]);

        store.deleteSymbolsByFile(fileId);

        // BLOB rows follow via ON DELETE CASCADE; vec0 has no FK — it must
        // be cleaned explicitly or orphans eat ANN top-k.
        expect(vstore.count()).toBe(0);
        expect(vstore.search([1, 0, 0], 5)).toEqual([]);
        if (annAvailable) expect(vecCount(db)).toBe(0);
      } finally {
        db.close();
      }
    });

    it('reopening prunes vec0 orphans left by pre-fix deletes (orphan direction)', () => {
      const { db, store, vstore } = realDb();
      try {
        const a = addFile(store, 'a.ts', ['foo', 'bar']);
        const b = addFile(store, 'b.ts', ['baz']);
        for (const id of a.ids) vstore.insert(id, [1, 0, 0]);
        for (const id of b.ids) vstore.insert(id, [0, 0, 1]);

        // Simulate a pre-fix database: raw symbol delete cascades the BLOB
        // rows but leaves vec0 orphans behind (vec 3 > blob 1 — the old
        // `vec.count() >= count()` check called this "in sync").
        db.prepare('DELETE FROM symbols WHERE file_id = ?').run(a.fileId);
        expect(vstore.count()).toBe(1);

        const reopened = new BlobVectorStore(db);
        expect(reopened.count()).toBe(1);
        if (annAvailable) {
          expect(vecCount(db)).toBe(1);
          // Deleted ids must not pollute ANN top-k.
          const res = reopened.search([1, 0, 0], 5);
          expect(res.some((r) => a.ids.includes(r.id))).toBe(false);
        }
      } finally {
        db.close();
      }
    });

    it('reopening with zero live symbols drops stale vec rows', () => {
      const { db, store, vstore } = realDb();
      try {
        const { ids } = addFile(store, 'a.ts', ['foo']);
        for (const id of ids) vstore.insert(id, [1, 0, 0]);

        db.prepare('DELETE FROM symbols').run();

        const reopened = new BlobVectorStore(db);
        expect(reopened.count()).toBe(0);
        expect(reopened.search([1, 0, 0], 5)).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('shouldRebuildVecIndex prefers rebuild only past the bloat threshold', () => {
      // Below the absolute floor — prune row-by-row even at a high ratio.
      expect(shouldRebuildVecIndex(999, 1)).toBe(false);
      // At the ratio boundary — rebuild and compact the shadow chunks.
      expect(shouldRebuildVecIndex(1000, 4000)).toBe(true);
      expect(shouldRebuildVecIndex(30000, 70000)).toBe(true);
      // Many orphans but a small share of a huge index — prune.
      expect(shouldRebuildVecIndex(5000, 100000)).toBe(false);
      expect(shouldRebuildVecIndex(0, 100)).toBe(false);
    });
  });

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
