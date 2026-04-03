/**
 * Integration test: EmbeddingPipeline + indexing pipeline cooperation.
 * Verifies that after structural indexing, embeddings can be generated
 * for newly indexed symbols (the pattern used in cli.ts serve command).
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript.js';
import { BlobVectorStore } from '../../src/ai/vector-store.js';
import { EmbeddingPipeline } from '../../src/ai/embedding-pipeline.js';
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

function makeMockEmbeddingService(): EmbeddingService {
  return {
    async embed(_text: string) {
      return [Math.random(), Math.random(), Math.random()];
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => [Math.random(), Math.random(), Math.random()]);
    },
    dimensions() {
      return 3;
    },
  };
}

describe('EmbeddingPipeline CLI integration', () => {
  it('indexes embeddings for all symbols after structural indexing', async () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    const result = await pipeline.indexAll();
    expect(result.indexed).toBeGreaterThan(0);

    const symbolCount = (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }).c;
    expect(symbolCount).toBeGreaterThan(0);

    // No embeddings yet
    const vectorStore = new BlobVectorStore(db);
    expect(vectorStore.count()).toBe(0);

    // Run embedding pipeline (simulates what cli.ts does after indexAll)
    const embeddingPipeline = new EmbeddingPipeline(store, makeMockEmbeddingService(), vectorStore);
    const embedded = await embeddingPipeline.indexUnembedded();

    expect(embedded).toBe(symbolCount);
    expect(vectorStore.count()).toBe(symbolCount);
  });

  it('indexUnembedded is idempotent — second call embeds nothing', async () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    const config = makeConfig();
    await new IndexingPipeline(store, registry, config, FIXTURE_DIR).indexAll();

    const vectorStore = new BlobVectorStore(db);
    const embeddingPipeline = new EmbeddingPipeline(store, makeMockEmbeddingService(), vectorStore);

    const first = await embeddingPipeline.indexUnembedded();
    const second = await embeddingPipeline.indexUnembedded();

    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it('embedding service errors do not crash the flow', async () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    store.insertFile('test.ts', 'typescript', 'abc', 100);
    store.insertSymbol(1, { symbolId: 's1', name: 'Foo', kind: 'class', byteStart: 0, byteEnd: 50 });

    const failingService: EmbeddingService = {
      async embed() { throw new Error('network error'); },
      async embedBatch() { throw new Error('network error'); },
      dimensions() { return 3; },
    };

    const vectorStore = new BlobVectorStore(db);
    const embeddingPipeline = new EmbeddingPipeline(store, failingService, vectorStore);

    // Should not throw
    const count = await embeddingPipeline.indexUnembedded();
    expect(count).toBe(0);
    expect(vectorStore.count()).toBe(0);
  });

  it('runEmbeddings pattern: pipeline fires and forgets after indexFiles', async () => {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

    const config = makeConfig();
    const indexingPipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);

    const vectorStore = new BlobVectorStore(db);
    const embeddedCounts: number[] = [];
    const trackingService: EmbeddingService = {
      async embedBatch(texts: string[]) {
        embeddedCounts.push(texts.length);
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
      async embed(_t: string) { return [0.1, 0.2, 0.3]; },
      dimensions() { return 3; },
    };

    const embeddingPipeline = new EmbeddingPipeline(store, trackingService, vectorStore);

    // Simulate the runEmbeddings pattern from cli.ts
    const runEmbeddings = () => {
      embeddingPipeline.indexUnembedded().catch(vi.fn());
    };

    await indexingPipeline.indexAll().then(runEmbeddings);

    // Give async embedding a moment to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(embeddedCounts.length).toBeGreaterThan(0);
    expect(vectorStore.count()).toBeGreaterThan(0);
  });
});
