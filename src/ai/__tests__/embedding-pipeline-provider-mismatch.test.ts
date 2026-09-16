import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EmbeddingPipeline } from '../embedding-pipeline.js';
import type { EmbeddingService } from '../interfaces.js';
import { BlobVectorStore, ProviderMismatchError } from '../vector-store.js';

/**
 * Provider/model swap coverage (TRA-1539): switching the ONNX default model
 * (or any embedding model) must never silently mix vector spaces. The
 * pipeline either auto-rebuilds (default) or throws ProviderMismatchError
 * when `autoRebuildOnProviderMismatch: false` — this test pins both paths so
 * the E5 opt-in migration can't regress into a silent garbage-similarity
 * index.
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

function modelService(model: string, dim = 384): EmbeddingService {
  return {
    async embed() {
      return Array.from({ length: dim }, () => 0.1);
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => Array.from({ length: dim }, () => 0.1));
    },
    dimensions() {
      return dim;
    },
    modelName() {
      return model;
    },
    providerName() {
      return 'onnx';
    },
  };
}

const OLD_MODEL = 'Xenova/all-MiniLM-L6-v2';
const NEW_MODEL = 'Xenova/multilingual-e5-small';

describe('EmbeddingPipeline provider/model swap (TRA-1539)', () => {
  it('auto-rebuild (default): drops the old vector space and re-embeds under the new model', async () => {
    const db = seedDb(2);
    const vectorStore = new BlobVectorStore(db);
    // Existing index built with MiniLM…
    vectorStore.setMeta(OLD_MODEL, 384, 'onnx');
    vectorStore.insert(
      1,
      Array.from({ length: 384 }, () => 0.2),
    );

    const pipeline = new EmbeddingPipeline(fakeStore(db, 2), modelService(NEW_MODEL), vectorStore);
    const indexed = await pipeline.indexUnembedded(50);

    expect(indexed).toBe(2);
    expect(vectorStore.getMeta()).toMatchObject({ model: NEW_MODEL, dim: 384 });
    expect(vectorStore.count()).toBe(2);
  });

  it('autoRebuildOnProviderMismatch=false: throws ProviderMismatchError instead of rewriting', async () => {
    const db = seedDb(2);
    const vectorStore = new BlobVectorStore(db);
    vectorStore.setMeta(OLD_MODEL, 384, 'onnx');
    vectorStore.insert(
      1,
      Array.from({ length: 384 }, () => 0.2),
    );

    const pipeline = new EmbeddingPipeline(
      fakeStore(db, 2),
      modelService(NEW_MODEL),
      vectorStore,
      undefined,
      {
        autoRebuildOnProviderMismatch: false,
      },
    );
    await expect(pipeline.indexUnembedded(50)).rejects.toBeInstanceOf(ProviderMismatchError);

    // Nothing was rewritten: old vectors and old stamp survive the refusal.
    expect(vectorStore.getMeta()).toMatchObject({ model: OLD_MODEL });
    expect(vectorStore.count()).toBe(1);
  });

  it('same model, same dim, same provider: no rebuild, no throw', async () => {
    const db = seedDb(2);
    const vectorStore = new BlobVectorStore(db);
    vectorStore.setMeta(OLD_MODEL, 384, 'onnx');

    const pipeline = new EmbeddingPipeline(
      fakeStore(db, 2),
      modelService(OLD_MODEL),
      vectorStore,
      undefined,
      { autoRebuildOnProviderMismatch: false },
    );
    const indexed = await pipeline.indexUnembedded(50);
    expect(indexed).toBe(2);
  });
});
