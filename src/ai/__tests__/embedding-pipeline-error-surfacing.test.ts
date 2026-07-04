import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EmbeddingPipeline } from '../embedding-pipeline.js';
import type { EmbeddingService } from '../interfaces.js';
import { BlobVectorStore } from '../vector-store.js';

/**
 * Minimal DB with just the tables EmbeddingPipeline.embedBatch touches, seeded
 * with N unembedded symbols. Avoids standing up the full Store.
 */
function seedDb(symbolCount: number): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE symbols (
      id INTEGER PRIMARY KEY,
      name TEXT, fqn TEXT, kind TEXT, signature TEXT, summary TEXT
    );
  `);
  const ins = db.prepare('INSERT INTO symbols (id, name, kind) VALUES (?, ?, ?)');
  for (let i = 1; i <= symbolCount; i++) ins.run(i, `sym${i}`, 'function');
  return db;
}

/** Store-shaped stub exposing only what EmbeddingPipeline reads. */
function fakeStore(db: Database.Database, totalSymbols: number) {
  return {
    db,
    countUnembeddedSymbols(): number {
      const row = db
        .prepare(
          'SELECT COUNT(*) AS c FROM symbols s LEFT JOIN symbol_embeddings se ON se.symbol_id = s.id WHERE se.symbol_id IS NULL',
        )
        .get() as { c: number };
      return row.c;
    },
    getStats() {
      return { totalSymbols };
    },
  } as unknown as import('../../db/store.js').Store;
}

/**
 * Embedding service that *reports* `reportedDim` from dimensions() but actually
 * produces vectors of `actualDim`. When the two differ it reproduces the
 * original bug: the pipeline stamps the store with the wrong reported dim, then
 * every insert of the real-length vector throws DimensionMismatchError.
 */
function skewedService(reportedDim: number, actualDim = reportedDim): EmbeddingService {
  return {
    async embed() {
      return Array.from({ length: actualDim }, () => 0.1);
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => Array.from({ length: actualDim }, () => 0.1));
    },
    dimensions() {
      return reportedDim;
    },
    modelName() {
      return 'wrong-dim-model';
    },
    providerName() {
      return 'ollama';
    },
  };
}

describe('EmbeddingPipeline surfaces dimension-mismatch failures', () => {
  it('does not silently complete with 0 embedded — diagnostics flag the mismatch', async () => {
    const db = seedDb(3);
    const vectorStore = new BlobVectorStore(db);

    // Original bug: the Ollama service reported the wrong 768 default from
    // dimensions() but actually produced 1024-dim vectors. ensureConsistent
    // stamps the store at the reported 768 (which passes its own dim check),
    // then every insert of the real 1024-dim vector collides.
    const service = skewedService(768, 1024);
    const pipeline = new EmbeddingPipeline(fakeStore(db, 3), service, vectorStore);

    const indexed = await pipeline.indexUnembedded(50);

    expect(indexed).toBe(0);
    expect(vectorStore.count()).toBe(0);

    const diag = pipeline.getLastRunDiagnostics();
    expect(diag.failedBatches).toBeGreaterThan(0);
    expect(diag.dimensionMismatch).toBe(true);
    expect(diag.lastError).toMatch(/dimension mismatch/i);
  });

  it('reports a clean run with no diagnostics when dimensions agree', async () => {
    const db = seedDb(2);
    const vectorStore = new BlobVectorStore(db);

    const pipeline = new EmbeddingPipeline(fakeStore(db, 2), skewedService(4), vectorStore);
    const indexed = await pipeline.indexUnembedded(50);

    expect(indexed).toBe(2);
    expect(vectorStore.count()).toBe(2);
    const diag = pipeline.getLastRunDiagnostics();
    expect(diag.failedBatches).toBe(0);
    expect(diag.dimensionMismatch).toBe(false);
    expect(diag.breakerTripped).toBe(false);
  });
});
