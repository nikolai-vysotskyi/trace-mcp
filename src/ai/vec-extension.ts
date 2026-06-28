/**
 * Optional sqlite-vec ANN acceleration for {@link BlobVectorStore}.
 *
 * `sqlite-vec` is an optionalDependency. When it is installed and loads into the
 * connection, vector search drops from O(N) brute-force cosine to a sub-linear
 * vec0 KNN scan. When it is absent (Windows/CI/offline, or the load fails),
 * {@link Vec0Index.tryCreate} returns `null` and the caller keeps using
 * brute-force — zero behaviour change, identical results.
 *
 * The vec0 table is a derived ACCELERATOR over the canonical `symbol_embeddings`
 * BLOB table, never a replacement: the BLOB table still backs drift checks,
 * `repair_index` drop-vec, and the brute-force fallback.
 *
 * ponytail: vec0 mirrors the BLOB table, so vector storage roughly doubles while
 * the extension is active — the standard price of an ANN index. Uninstall
 * sqlite-vec to drop back to brute-force and reclaim the space.
 *
 * sqlite-vec binding quirks baked in here:
 *  - the integer primary key must be bound as a BigInt (a plain JS number is
 *    rejected with "Only integers are allowed for primary key values");
 *  - vectors are passed as raw little-endian float32 BLOBs wrapped in `vec_f32(?)`;
 *  - the column is declared `distance_metric=cosine`, so the `distance` it
 *    returns is `1 - cosine_similarity` — we invert it back to a similarity score
 *    to honour the {@link VectorStore} contract (higher = better).
 */
import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export class Vec0Index {
  private readonly table = 'vec_symbol_embeddings';
  private dim: number | null = null;
  private ready = false;

  private constructor(private readonly db: Database.Database) {}

  /** Load sqlite-vec into the connection. Returns null when unavailable. */
  static tryCreate(db: Database.Database): Vec0Index | null {
    // Already loaded on this connection (e.g. a second store over the same db)?
    try {
      db.prepare('SELECT vec_version()').get();
      return new Vec0Index(db);
    } catch {
      /* not loaded yet — try to load below */
    }
    try {
      const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };
      sqliteVec.load(db);
      db.prepare('SELECT vec_version()').get();
      return new Vec0Index(db);
    } catch {
      return null;
    }
  }

  /** Create the vec0 virtual table for a given dimensionality (idempotent per dim). */
  private ensure(dim: number): boolean {
    if (this.ready) return this.dim === dim;
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table} USING vec0(` +
          `symbol_id integer primary key, embedding float[${dim}] distance_metric=cosine)`,
      );
      this.dim = dim;
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  insert(id: number, vectorBuf: Buffer, dim: number): void {
    if (!this.ensure(dim)) return;
    try {
      // vec0 does NOT honour INSERT OR REPLACE (it throws UNIQUE on the pk), so
      // emulate upsert with delete-then-insert — otherwise a replaced embedding
      // would silently keep its stale vector.
      const bid = BigInt(id);
      this.db.prepare(`DELETE FROM ${this.table} WHERE symbol_id = ?`).run(bid);
      this.db
        .prepare(`INSERT INTO ${this.table}(symbol_id, embedding) VALUES (?, vec_f32(?))`)
        .run(bid, vectorBuf);
    } catch {
      /* the BLOB table is canonical; a vec0 hiccup must never break indexing */
    }
  }

  delete(id: number): void {
    if (!this.ready) return;
    try {
      this.db.prepare(`DELETE FROM ${this.table} WHERE symbol_id = ?`).run(BigInt(id));
    } catch {
      /* ignore — stale accelerator row is harmless vs the canonical BLOB table */
    }
  }

  clear(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${this.table}`);
    } catch {
      /* ignore */
    }
    this.ready = false;
    this.dim = null;
  }

  count(): number {
    if (!this.ready) return 0;
    try {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${this.table}`).get() as { c: number };
      return row.c;
    } catch {
      return 0;
    }
  }

  /**
   * KNN search. Returns `null` to signal "not usable — fall back to brute-force"
   * (dim mismatch, or any vec0 error). An empty array is a real "no matches".
   */
  search(queryBuf: Buffer, limit: number, dim: number): { id: number; score: number }[] | null {
    if (!this.ensure(dim)) return null;
    try {
      const rows = this.db
        .prepare(
          `SELECT symbol_id AS id, distance FROM ${this.table} ` +
            `WHERE embedding MATCH vec_f32(?) ORDER BY distance LIMIT ?`,
        )
        .all(queryBuf, limit) as { id: number | bigint; distance: number }[];
      return rows.map((r) => ({ id: Number(r.id), score: 1 - r.distance }));
    } catch {
      return null;
    }
  }

  /**
   * Backfill a materialized chunk into the accelerator. The caller must pass a
   * fully-read array (not a live better-sqlite3 iterator) — writing while a read
   * iterator is open on the same connection throws.
   */
  backfill(rows: Array<{ symbol_id: number | bigint; embedding: Buffer }>, dim: number): void {
    if (!this.ensure(dim)) return;
    try {
      // delete-then-insert: vec0 rejects INSERT OR REPLACE (see insert()), and this
      // keeps backfill idempotent if it re-runs over a partially-populated index.
      const del = this.db.prepare(`DELETE FROM ${this.table} WHERE symbol_id = ?`);
      const ins = this.db.prepare(
        `INSERT INTO ${this.table}(symbol_id, embedding) VALUES (?, vec_f32(?))`,
      );
      const tx = this.db.transaction(() => {
        for (const r of rows) {
          const bid = BigInt(r.symbol_id);
          del.run(bid);
          ins.run(bid, r.embedding);
        }
      });
      tx();
    } catch {
      /* leave vec0 partially filled; search() returns null and brute-force covers it */
    }
  }
}
