/**
 * Regression tests for the embedding consistency layer:
 *  1. BlobVectorStore refuses wrong-dim vectors once meta is stamped.
 *  2. EmbeddingPipeline detects model/dim changes and re-embeds.
 *  3. SummarizationPipeline invalidates stale vectors on summary rewrite.
 */

import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { EmbeddingPipeline } from '../../src/ai/embedding-pipeline.js';
import type { EmbeddingService, InferenceService } from '../../src/ai/interfaces.js';
import { SummarizationPipeline } from '../../src/ai/summarization-pipeline.js';
import { BlobVectorStore, DimensionMismatchError } from '../../src/ai/vector-store.js';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';

function mkEmbed(dims: number, model: string): EmbeddingService {
  return {
    async embed() {
      return Array.from({ length: dims }, (_, i) => (i + 1) * 0.1);
    },
    async embedBatch(texts) {
      return texts.map(() => Array.from({ length: dims }, (_, i) => (i + 1) * 0.1));
    },
    dimensions() {
      return dims;
    },
    modelName() {
      return model;
    },
  };
}

const stubInference: InferenceService = {
  async generate() {
    return 'summary text';
  },
};

function seedThreeSymbols(db: Database.Database): void {
  db.exec(`
    INSERT INTO files (id, path, language, indexed_at) VALUES (1, 'f.ts', 'ts', datetime('now'));
    INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, signature, byte_start, byte_end)
      VALUES (1, 1, 's1', 'Foo', 'class', 'Foo', 'class Foo', 0, 10);
    INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, signature, byte_start, byte_end)
      VALUES (2, 1, 's2', 'Bar', 'class', 'Bar', 'class Bar', 10, 20);
    INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, signature, byte_start, byte_end)
      VALUES (3, 1, 's3', 'Baz', 'function', 'Baz', 'fn baz', 20, 30);
  `);
}

describe('BlobVectorStore dimension guards', () => {
  let db: Database.Database;
  let vectorStore: BlobVectorStore;

  beforeEach(() => {
    const store = createTestStore();
    db = store.db;
    seedThreeSymbols(db);
    vectorStore = new BlobVectorStore(db);
  });

  it('accepts any dim before meta is stamped', () => {
    expect(() => vectorStore.insert(1, [0.1, 0.2])).not.toThrow();
    expect(() => vectorStore.insert(2, [0.1, 0.2, 0.3, 0.4])).not.toThrow();
  });

  it('rejects wrong-dim insert after meta is stamped', () => {
    vectorStore.setMeta('model-a', 3);
    expect(() => vectorStore.insert(1, [0.1, 0.2, 0.3])).not.toThrow();
    expect(() => vectorStore.insert(2, [0.1, 0.2])).toThrow(DimensionMismatchError);
    expect(() => vectorStore.insert(3, [0.1, 0.2, 0.3, 0.4])).toThrow(DimensionMismatchError);
  });

  it('search returns [] instead of mixing dims', () => {
    vectorStore.setMeta('model-a', 3);
    vectorStore.insert(1, [1, 0, 0]);
    expect(vectorStore.search([1, 0, 0], 5).length).toBe(1);
    expect(vectorStore.search([1, 0], 5)).toEqual([]);
    expect(vectorStore.search([1, 0, 0, 0], 5)).toEqual([]);
  });

  it('clear() wipes vectors, keeps meta until reset', () => {
    vectorStore.setMeta('model-a', 3);
    vectorStore.insert(1, [1, 0, 0]);
    vectorStore.insert(2, [0, 1, 0]);
    vectorStore.clear();
    expect(vectorStore.count()).toBe(0);
    expect(vectorStore.getMeta()).toEqual({ model: 'model-a', dim: 3 });
  });

  it('setMeta updates cached dim so subsequent inserts revalidate', () => {
    vectorStore.setMeta('model-a', 3);
    expect(() => vectorStore.insert(1, [1, 0])).toThrow(DimensionMismatchError);
    vectorStore.clear();
    vectorStore.setMeta('model-b', 2);
    expect(() => vectorStore.insert(1, [1, 0])).not.toThrow();
    expect(() => vectorStore.insert(2, [1, 0, 0])).toThrow(DimensionMismatchError);
  });
});

describe('EmbeddingPipeline.ensureConsistent', () => {
  let store: Store;
  let db: Database.Database;
  let vectorStore: BlobVectorStore;

  beforeEach(() => {
    store = createTestStore();
    db = store.db;
    vectorStore = new BlobVectorStore(db);
    seedThreeSymbols(db);
  });

  it('stamps meta on first run without reindexing', async () => {
    // Pre-existing vectors (simulating post-migration state)
    vectorStore.insert(1, [0.1, 0.2, 0.3]);
    vectorStore.insert(2, [0.4, 0.5, 0.6]);

    const pipeline = new EmbeddingPipeline(store, mkEmbed(3, 'stable-model'), vectorStore);
    await pipeline.indexUnembedded();

    expect(vectorStore.getMeta()).toEqual({ model: 'stable-model', dim: 3 });
    // All 3 symbols now have embeddings (the third was embedded in this run)
    expect(vectorStore.count()).toBe(3);
  });

  it('drops vectors and re-embeds when model name changes', async () => {
    // First run with model-a
    const p1 = new EmbeddingPipeline(store, mkEmbed(3, 'model-a'), vectorStore);
    await p1.indexUnembedded();
    expect(vectorStore.count()).toBe(3);
    expect(vectorStore.getMeta()).toEqual({ model: 'model-a', dim: 3 });

    // Fresh pipeline with a different model, same dim
    const p2 = new EmbeddingPipeline(store, mkEmbed(3, 'model-b'), vectorStore);
    await p2.indexUnembedded();

    expect(vectorStore.getMeta()).toEqual({ model: 'model-b', dim: 3 });
    expect(vectorStore.count()).toBe(3);
  });

  it('drops vectors and re-embeds when dim changes', async () => {
    const p1 = new EmbeddingPipeline(store, mkEmbed(3, 'model-a'), vectorStore);
    await p1.indexUnembedded();
    expect(vectorStore.count()).toBe(3);

    // Switch to 8-dim embeddings — old 3-dim rows are incompatible
    const p2 = new EmbeddingPipeline(store, mkEmbed(8, 'model-a'), vectorStore);
    await p2.indexUnembedded();

    expect(vectorStore.getMeta()).toEqual({ model: 'model-a', dim: 8 });
    expect(vectorStore.count()).toBe(3);
  });

  it('no-op embedding service (dims=0) never stamps meta', async () => {
    const noop: EmbeddingService = {
      async embed() {
        return [];
      },
      async embedBatch(texts) {
        return texts.map(() => []);
      },
      dimensions() {
        return 0;
      },
      modelName() {
        return '';
      },
    };
    const pipeline = new EmbeddingPipeline(store, noop, vectorStore);
    await pipeline.indexUnembedded();
    expect(vectorStore.getMeta()).toBeNull();
    expect(vectorStore.count()).toBe(0);
  });

  it('reindexAll writes meta even when store was empty', async () => {
    const pipeline = new EmbeddingPipeline(store, mkEmbed(3, 'fresh-model'), vectorStore);
    await pipeline.reindexAll();
    expect(vectorStore.getMeta()).toEqual({ model: 'fresh-model', dim: 3 });
    expect(vectorStore.count()).toBe(3);
  });
});

describe('SummarizationPipeline invalidates stale embeddings', () => {
  it('deletes vectors for symbols whose summary was just (re)written', async () => {
    const store = createTestStore();
    const db = store.db;
    const vectorStore = new BlobVectorStore(db);
    seedThreeSymbols(db);

    // Embed everything first
    const embedPipe = new EmbeddingPipeline(store, mkEmbed(3, 'm'), vectorStore);
    await embedPipe.indexUnembedded();
    expect(vectorStore.count()).toBe(3);

    const summaryPipe = new SummarizationPipeline(
      store,
      stubInference,
      process.cwd(),
      { batchSize: 10, kinds: ['class', 'function'], concurrency: 1 },
      undefined,
      vectorStore,
    );
    // Summarizer reads source via fs — the fixture path doesn't exist, so
    // readSource returns null. The pipeline still calls generate+updateSummary
    // and thus should call vectorStore.delete for each row returned.
    await summaryPipe.summarizeUnsummarized();

    // After summarization the stale vectors should be gone, ready for re-embed.
    expect(vectorStore.count()).toBe(0);
  });

  it('is a no-op when vectorStore is not passed', async () => {
    const store = createTestStore();
    const db = store.db;
    const vectorStore = new BlobVectorStore(db);
    seedThreeSymbols(db);

    const embedPipe = new EmbeddingPipeline(store, mkEmbed(3, 'm'), vectorStore);
    await embedPipe.indexUnembedded();

    const summaryPipe = new SummarizationPipeline(store, stubInference, process.cwd(), {
      batchSize: 10,
      kinds: ['class', 'function'],
      concurrency: 1,
    });
    await summaryPipe.summarizeUnsummarized();

    // No vectorStore threaded through → vectors untouched
    expect(vectorStore.count()).toBe(3);
  });
});
