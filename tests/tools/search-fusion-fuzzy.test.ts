/**
 * Honesty signals for fusion + fuzzy modes.
 *
 * Bugs being prevented:
 *   1. Fusion mode used to silently no-op when no embeddings were populated —
 *      callers got back FTS-ranked results with no indication the similarity
 *      channel was skipped. Now `_meta.fusion.semantic_channel` is always set
 *      to "active" or "skipped" with a human-readable reason.
 *   2. Fuzzy mode used to return an empty `items[]` with a misleading
 *      "do not retry with similar terms" suggestion when the strict
 *      threshold/edit-distance ruled everything out. Now a wider trigram
 *      scan surfaces the top-N closest names in `_near_misses` so the
 *      caller has concrete candidates to retry against.
 */
import path from 'node:path';
import type Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EmbeddingService } from '../../src/ai/interfaces.js';
import { BlobVectorStore } from '../../src/ai/vector-store.js';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { search } from '../../src/tools/navigation/navigation.js';
import { createTestStore } from '../test-utils.js';

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

/**
 * Deterministic mock embedding — vector is derived from the input text so
 * cosine similarity between identical strings is 1.0 and different strings
 * produce different vectors. Avoids the flakiness of Math.random().
 */
function createDeterministicEmbedding(dims = 16, model = 'mock-model'): EmbeddingService {
  function vec(text: string): number[] {
    const out = new Array<number>(dims).fill(0);
    for (let i = 0; i < text.length; i++) {
      out[i % dims] += text.charCodeAt(i);
    }
    // L2-normalize so cosine similarity is well-behaved.
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
    return out.map((v) => v / norm);
  }
  return {
    async embed(text: string) {
      return vec(text);
    },
    async embedBatch(texts: string[]) {
      return texts.map(vec);
    },
    dimensions() {
      return dims;
    },
    modelName() {
      return model;
    },
  };
}

describe('search() — fusion honesty signal', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE_DIR);
    await pipeline.indexAll();
  });

  it('fusion with no embeddings → _meta.fusion.semantic_channel === "skipped"', async () => {
    const result = await search(store, 'User', undefined, 20, 0, undefined, undefined, undefined, {
      fusion: true,
    });
    expect(result.search_mode).toBe('fusion');
    expect(result._meta?.fusion).toBeDefined();
    expect(result._meta?.fusion?.semantic_channel).toBe('skipped');
    // The reason should mention either embeddings or AI provider so the
    // caller knows exactly what's missing.
    expect(result._meta?.fusion?.reason).toMatch(/embed|AI provider|embeddings/i);
    // Contributions still reported so the caller sees which channels fired.
    expect(result._meta?.fusion?.contributions).toBeDefined();
    expect(result._meta?.fusion?.contributions?.similarity).toBe(0);
  });

  it('fusion with embeddings populated → _meta.fusion.semantic_channel === "active"', async () => {
    // Pre-populate embeddings for enough symbols to clear the threshold.
    const db: Database = store.db;
    const vectorStore = new BlobVectorStore(db);
    const embedding = createDeterministicEmbedding();
    const symbols = db.prepare('SELECT id, name, fqn FROM symbols LIMIT 50').all() as Array<{
      id: number;
      name: string;
      fqn: string | null;
    }>;
    expect(symbols.length).toBeGreaterThanOrEqual(10);
    for (const sym of symbols) {
      const vec = await embedding.embed(`${sym.name} ${sym.fqn ?? ''}`, 'document');
      vectorStore.insert(sym.id, vec);
    }
    vectorStore.setMeta(embedding.modelName(), embedding.dimensions(), 'mock-provider');

    const result = await search(
      store,
      'User',
      undefined,
      20,
      0,
      { vectorStore, embeddingService: embedding, reranker: null },
      undefined,
      undefined,
      { fusion: true },
    );
    expect(result.search_mode).toBe('fusion');
    expect(result._meta?.fusion).toBeDefined();
    expect(result._meta?.fusion?.semantic_channel).toBe('active');
    expect(result._meta?.fusion?.reason).toBeUndefined();
    expect(result._meta?.fusion?.contributions?.similarity).toBeGreaterThan(0);

    // Clean up so other tests in this file start from a known state.
    vectorStore.clear();
  });
});

describe('search() — fuzzy near-miss surfacing', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE_DIR);
    await pipeline.indexAll();

    // Inject a known symbol so the typo-match test has a deterministic target
    // regardless of fixture churn. `registerTool` is the canonical mis-typed
    // target from the bug report.
    store.db.exec(`
      INSERT OR IGNORE INTO files (id, path, language, indexed_at, content_hash, byte_length)
        VALUES (9999, 'tests/fixtures/near-miss/seed.ts', 'typescript', datetime('now'), 'seed', 100);
      INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, signature, byte_start, byte_end, line_start, line_end)
        VALUES (9999, 'seed::registerTool', 'registerTool', 'function', 'seed::registerTool',
                'function registerTool()', 0, 50, 1, 5);
    `);
    // Re-index trigrams for the freshly inserted symbol so fuzzy search finds it.
    const inserted = store.db
      .prepare("SELECT id, name, fqn FROM symbols WHERE symbol_id = 'seed::registerTool'")
      .get() as { id: number; name: string; fqn: string | null } | undefined;
    if (inserted) {
      const { indexTrigramsBatch } = await import('../../src/db/fuzzy.js');
      indexTrigramsBatch(store.db, [inserted]);
    }
  });

  it('fuzzy "registTool" → _near_misses includes "registerTool"', async () => {
    // The default fuzzy threshold (0.3) + edit distance (3) would normally
    // catch "registerTool" because edit distance is 2 — but the bug report
    // is about queries where the strict run returns nothing. We tighten the
    // fuzzy params here to force a zero-hit so the wider near-miss scan
    // takes over.
    const result = await search(store, 'registTool', undefined, 20, 0, undefined, {
      fuzzy: true,
      fuzzyThreshold: 0.9,
      maxEditDistance: 1,
    });
    expect(result.items).toEqual([]);
    expect(result._near_misses).toBeDefined();
    expect(result._near_misses!.length).toBeGreaterThan(0);
    expect(result._near_misses!.map((m) => m.name)).toContain('registerTool');
    // Each near-miss carries enough info to re-query.
    const seeded = result._near_misses!.find((m) => m.name === 'registerTool')!;
    expect(seeded.symbol_id).toBe('seed::registerTool');
    expect(seeded.file).toBe('tests/fixtures/near-miss/seed.ts');
    expect(seeded.distance).toBeGreaterThanOrEqual(0);
    expect(seeded.similarity).toBeGreaterThan(0);
  });

  it('fuzzy "completelyMadeUpXyzNothingMatches999" → _near_misses absent or empty', async () => {
    const result = await search(
      store,
      'completelyMadeUpXyzNothingMatches999',
      undefined,
      20,
      0,
      undefined,
      { fuzzy: true, fuzzyThreshold: 0.9, maxEditDistance: 1 },
    );
    expect(result.items).toEqual([]);
    // Either no near-misses at all (most likely for an extreme typo) or a
    // small low-similarity list — both demonstrate the path executed.
    const misses = result._near_misses ?? [];
    expect(misses.length).toBeLessThanOrEqual(5);
    for (const m of misses) {
      // If anything surfaced, it must be a real symbol with a real file.
      expect(m.name).toBeTruthy();
      expect(m.file).toBeTruthy();
      expect(m.symbol_id).toBeTruthy();
    }
  });
});
