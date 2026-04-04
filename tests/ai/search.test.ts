import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { hybridSearch } from '../../src/ai/search.js';
import { BlobVectorStore } from '../../src/ai/vector-store.js';
import type { VectorStore, EmbeddingService } from '../../src/ai/interfaces.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type Database from 'better-sqlite3';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/no-framework');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['app/**/*.php', 'src/**/*.ts', 'components/**/*.vue'],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('hybridSearch', () => {
  let db: Database.Database;
  let store: Store;

  beforeAll(async () => {
    db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();
  });

  it('FTS-only search works when vector store is null', async () => {
    const results = await hybridSearch(db, 'User', null, null, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.name === 'User')).toBe(true);
  });

  it('returns empty for nonsense query with no vector store', async () => {
    const results = await hybridSearch(db, 'xyzzyplugh99', null, null, 10);
    expect(results).toHaveLength(0);
  });

  it('results are sorted by score descending', async () => {
    const results = await hybridSearch(db, 'User', null, null, 20);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('RRF fusion merges FTS and vector results', async () => {
    const vectorStore = new BlobVectorStore(db);

    // Get all symbols and give them embeddings
    const symbols = db.prepare('SELECT id, name FROM symbols').all() as { id: number; name: string }[];
    for (const sym of symbols) {
      // Create a unique vector for each symbol
      const vec = new Array(3).fill(0);
      vec[sym.id % 3] = 1;
      vectorStore.insert(sym.id, vec);
    }

    // Mock embedding service that returns a fixed query vector
    const mockEmbedding: EmbeddingService = {
      async embed(_text: string) { return [1, 0, 0]; },
      async embedBatch(texts: string[]) { return texts.map(() => [1, 0, 0]); },
      dimensions() { return 3; },
    };

    const results = await hybridSearch(db, 'User', vectorStore, mockEmbedding, 20);
    expect(results.length).toBeGreaterThan(0);

    // All results should have scores
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it('deduplication works — no duplicate symbolIds in results', async () => {
    const results = await hybridSearch(db, 'User', null, null, 20);
    const ids = results.map((r) => r.symbolId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
