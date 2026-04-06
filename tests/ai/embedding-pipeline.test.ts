import { describe, it, expect, beforeEach } from 'vitest';
import { createTestStore } from '../test-utils.js';
import { BlobVectorStore } from '../../src/ai/vector-store.js';
import { EmbeddingPipeline } from '../../src/ai/embedding-pipeline.js';
import type { Store } from '../../src/db/store.js';
import type { EmbeddingService } from '../../src/ai/interfaces.js';
import type Database from 'better-sqlite3';

function createMockEmbedding(dims = 3): EmbeddingService {
  return {
    async embed(_text: string) {
      return Array.from({ length: dims }, () => Math.random());
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => Array.from({ length: dims }, () => Math.random()));
    },
    dimensions() {
      return dims;
    },
  };
}

describe('EmbeddingPipeline', () => {
  let db: Database.Database;
  let store: Store;
  let vectorStore: BlobVectorStore;

  beforeEach(() => {
    store = createTestStore();
    db = store.db;
    vectorStore = new BlobVectorStore(db);

    // Insert test symbols
    db.exec(`
      INSERT INTO files (id, path, language, indexed_at) VALUES (1, 'test.ts', 'ts', datetime('now'));
      INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, signature, byte_start, byte_end)
        VALUES (1, 1, 'sym-1', 'Foo', 'class', 'App.Foo', 'class Foo {}', 0, 100);
      INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, signature, byte_start, byte_end)
        VALUES (2, 1, 'sym-2', 'Bar', 'class', 'App.Bar', 'class Bar {}', 100, 200);
      INSERT INTO symbols (id, file_id, symbol_id, name, kind, fqn, signature, byte_start, byte_end)
        VALUES (3, 1, 'sym-3', 'Baz', 'function', 'App.Baz', 'function baz() {}', 200, 300);
    `);
  });

  it('indexes symbols that have no embeddings', async () => {
    const pipeline = new EmbeddingPipeline(store, createMockEmbedding(), vectorStore);
    const count = await pipeline.indexUnembedded();
    expect(count).toBe(3);
    expect(vectorStore.count()).toBe(3);
  });

  it('skips already-embedded symbols', async () => {
    // Pre-embed one symbol
    vectorStore.insert(1, [1, 0, 0]);

    const pipeline = new EmbeddingPipeline(store, createMockEmbedding(), vectorStore);
    const count = await pipeline.indexUnembedded();
    expect(count).toBe(2);
    expect(vectorStore.count()).toBe(3);
  });

  it('indexSymbol embeds a single symbol', async () => {
    const pipeline = new EmbeddingPipeline(store, createMockEmbedding(), vectorStore);
    await pipeline.indexSymbol(1, 'class Foo');
    expect(vectorStore.count()).toBe(1);
  });

  it('reindexAll clears and re-embeds everything', async () => {
    // Pre-embed one symbol
    vectorStore.insert(1, [1, 0, 0]);

    const pipeline = new EmbeddingPipeline(store, createMockEmbedding(), vectorStore);
    const count = await pipeline.reindexAll();
    expect(count).toBe(3);
    expect(vectorStore.count()).toBe(3);
  });

  it('returns 0 when all symbols already embedded', async () => {
    vectorStore.insert(1, [1, 0, 0]);
    vectorStore.insert(2, [0, 1, 0]);
    vectorStore.insert(3, [0, 0, 1]);

    const pipeline = new EmbeddingPipeline(store, createMockEmbedding(), vectorStore);
    const count = await pipeline.indexUnembedded();
    expect(count).toBe(0);
  });

  it('handles embedding service failure gracefully', async () => {
    const failingService: EmbeddingService = {
      async embed() { throw new Error('network error'); },
      async embedBatch() { throw new Error('network error'); },
      dimensions() { return 3; },
    };

    const pipeline = new EmbeddingPipeline(store, failingService, vectorStore);
    const count = await pipeline.indexUnembedded();
    expect(count).toBe(0);
  });
});
