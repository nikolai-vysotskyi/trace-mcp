/**
 * Synthetic `__module__` pseudo-symbols must not reach a caller through ANY
 * retrieval channel (TRA-985).
 *
 * The first version of that fix pushed the exclusion into `searchFts` only, so
 * it held for lexical search and leaked everywhere a candidate arrives by some
 * other route: the vector channel of `semantic="auto"/"on"/"only"` and the
 * similarity channel of fusion both merge symbol ids that never touched that
 * SQL predicate. With embeddings configured, `search("UserCard")` returned the
 * pseudo-symbol the fix claimed to have removed — the leak depended on the
 * user's AI configuration, which is the worst place for behaviour to differ.
 */
import path from 'node:path';
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
/** The Vue SFC in the fixture emits exactly one module-body pseudo-symbol. */
const QUERY = 'UserCard';

function deterministicEmbedding(dims = 16): EmbeddingService {
  const vec = (text: string): number[] => {
    const out = new Array<number>(dims).fill(0);
    for (let i = 0; i < text.length; i++) out[i % dims] += text.charCodeAt(i);
    const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
    return out.map((v) => v / norm);
  };
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
      return 'mock-model';
    },
  };
}

let store: Store;
let aiOptions: { vectorStore: BlobVectorStore; embeddingService: EmbeddingService; reranker: null };

beforeAll(async () => {
  store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new PhpLanguagePlugin());
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  registry.registerLanguagePlugin(new VueLanguagePlugin());
  const config: TraceMcpConfig = {
    root: FIXTURE_DIR,
    // PHP included so the fixture clears MIN_EMBEDDINGS_FOR_SEMANTIC (10) —
    // below it fusion skips its similarity channel and the fusion case here
    // would silently prove nothing.
    include: ['app/**/*.php', 'src/**/*.ts', 'components/**/*.vue'],
    exclude: [],
    plugins: [],
  };
  await new IndexingPipeline(store, registry, config, FIXTURE_DIR).indexAll();

  // Embed EVERY symbol, module bodies included — that is what makes the vector
  // channel able to surface one, and it is what a real `embed_repo` does.
  const vectorStore = new BlobVectorStore(store.db);
  const embeddingService = deterministicEmbedding();
  const symbols = store.db.prepare('SELECT id, name, fqn FROM symbols').all() as Array<{
    id: number;
    name: string;
    fqn: string | null;
  }>;
  for (const sym of symbols) {
    vectorStore.insert(sym.id, await embeddingService.embed(`${sym.name} ${sym.fqn ?? ''}`, 'document'));
  }
  vectorStore.setMeta(embeddingService.modelName(), embeddingService.dimensions(), 'mock');
  aiOptions = { vectorStore, embeddingService, reranker: null };
});

const names = (r: { items: Array<{ symbol: { name: string } }> }): string[] =>
  r.items.map((i) => i.symbol.name);

describe('module-body pseudo-symbols never reach the caller', () => {
  it('the fixture really does index one, or this whole file proves nothing', () => {
    const row = store.db
      .prepare("SELECT name FROM symbols WHERE name GLOB '__module__*'")
      .get() as { name: string } | undefined;
    expect(row?.name).toMatch(/^__module__/);
  });

  it('lexical search drops it', async () => {
    expect(names(await search(store, QUERY)).some((n) => n.startsWith('__module__'))).toBe(false);
  });

  for (const semantic of ['auto', 'on', 'only'] as const) {
    it(`hybrid search drops it with semantic="${semantic}"`, async () => {
      const result = await search(store, QUERY, undefined, 20, 0, aiOptions, undefined, {
        semantic,
      });
      expect(result.items.length).toBeGreaterThan(0);
      expect(names(result).some((n) => n.startsWith('__module__'))).toBe(false);
    });
  }

  it('fusion drops it on both channels', async () => {
    const result = await search(
      store,
      QUERY,
      undefined,
      20,
      0,
      aiOptions,
      undefined,
      undefined,
      { fusion: true },
    );
    // Assert the channel actually ran: with too few embeddings fusion skips
    // similarity entirely and this case would pass without testing anything.
    expect(result._meta?.fusion?.semantic_channel).toBe('active');
    expect(result.items.length).toBeGreaterThan(0);
    expect(names(result).some((n) => n.startsWith('__module__'))).toBe(false);
  });

  it('still returns it on every path when the query asks for it by name', async () => {
    const lexical = await search(store, '__module__');
    expect(lexical.items.length).toBeGreaterThan(0);
    expect(names(lexical).some((n) => n.startsWith('__module__'))).toBe(true);

    const hybrid = await search(store, '__module__', undefined, 20, 0, aiOptions, undefined, {
      semantic: 'auto',
    });
    expect(names(hybrid).some((n) => n.startsWith('__module__'))).toBe(true);
  });
});

