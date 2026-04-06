/**
 * Integration test: hybrid AI search (FTS + vector).
 * Verifies search() returns search_mode='hybrid_ai' when vector store is populated.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { BlobVectorStore } from '../../src/ai/vector-store.js';
import { EmbeddingPipeline } from '../../src/ai/embedding-pipeline.js';
import { search } from '../../src/tools/navigation/navigation.js';
import type { EmbeddingService } from '../../src/ai/interfaces.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/no-framework');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['src/**/*.ts'],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
  };
}

/** Deterministic mock — returns consistent vectors so similarity is meaningful */
function makeMockEmbedding(): EmbeddingService {
  const cache = new Map<string, number[]>();
  return {
    async embed(text: string) {
      if (cache.has(text)) return cache.get(text)!;
      // Simple hash-based vector for determinism
      const vec = Array.from({ length: 8 }, (_, i) => {
        let h = 0;
        for (const c of text) h = ((h << 5) - h + c.charCodeAt(0) + i) | 0;
        return (h % 1000) / 1000;
      });
      cache.set(text, vec);
      return vec;
    },
    async embedBatch(texts: string[]) {
      return Promise.all(texts.map((t) => this.embed(t)));
    },
    dimensions() {
      return 8;
    },
  };
}

describe('Hybrid AI search', () => {
  let store: ReturnType<typeof createTestStore>;
  let vectorStore: BlobVectorStore;
  let embeddingService: EmbeddingService;

  beforeAll(async () => {
    store = createTestStore();
    const db = store.db;
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();

    // Populate vector store
    vectorStore = new BlobVectorStore(db);
    embeddingService = makeMockEmbedding();
    const embeddingPipeline = new EmbeddingPipeline(store, embeddingService, vectorStore);
    await embeddingPipeline.indexUnembedded();

    expect(vectorStore.count()).toBeGreaterThan(0);
  });

  it('returns search_mode=fts when no AI options provided', async () => {
    const result = await search(store, 'add', {}, 10, 0);
    expect(result.search_mode).toBe('fts');
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('returns search_mode=hybrid_ai when vector store + embedding service provided', async () => {
    const result = await search(store, 'add', {}, 10, 0, {
      vectorStore,
      embeddingService,
    });
    expect(result.search_mode).toBe('hybrid_ai');
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('hybrid results include score and symbol data', async () => {
    const result = await search(store, 'User', {}, 10, 0, {
      vectorStore,
      embeddingService,
    });
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.symbol).toBeDefined();
      expect(item.file).toBeDefined();
    }
  });

  it('hybrid results are sorted by score descending', async () => {
    const result = await search(store, 'User', {}, 20, 0, {
      vectorStore,
      embeddingService,
    });
    for (let i = 1; i < result.items.length; i++) {
      expect(result.items[i - 1].score).toBeGreaterThanOrEqual(result.items[i].score);
    }
  });

  it('FTS returns empty for nonsense query', async () => {
    const fts = await search(store, 'zzzznonexistent999', {}, 10, 0);
    expect(fts.items).toHaveLength(0);
    expect(fts.search_mode).toBe('fts');
  });

  it('hybrid may return results for nonsense (vector similarity is fuzzy)', async () => {
    const hybrid = await search(store, 'zzzznonexistent999', {}, 10, 0, {
      vectorStore,
      embeddingService,
    });
    // Vector search always finds nearest neighbors — we just verify it doesn't crash
    expect(hybrid.search_mode).toBe('hybrid_ai');
  });
});
