import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { getFeatureContext, tokenizeDescription } from '../../src/tools/navigation/context.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/laravel-10');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['app/**/*.php', 'routes/**/*.php', 'database/migrations/**/*.php'],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('get_feature_context', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    registry.registerFrameworkPlugin(new VueFrameworkPlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();
  });

  it('returns relevant symbols for "user" query', () => {
    const result = getFeatureContext(store, FIXTURE_DIR, 'user management');
    expect(result.items.length).toBeGreaterThan(0);
    // Should find User-related symbols
    const names = result.items.map((i) => i.name.toLowerCase());
    expect(names.some((n) => n.includes('user'))).toBe(true);
  });

  it('respects token budget', () => {
    const small = getFeatureContext(store, FIXTURE_DIR, 'user', 100);
    const large = getFeatureContext(store, FIXTURE_DIR, 'user', 10000);
    expect(small.totalTokens).toBeLessThanOrEqual(100);
    expect(large.items.length).toBeGreaterThanOrEqual(small.items.length);
  });

  it('returns empty for gibberish query', () => {
    const result = getFeatureContext(store, FIXTURE_DIR, 'xyzzyplugh99');
    expect(result.items).toHaveLength(0);
  });

  it('returns description in result', () => {
    const result = getFeatureContext(store, FIXTURE_DIR, 'user posts');
    expect(result.description).toBe('user posts');
  });

  it('includes detail level for each item', () => {
    const result = getFeatureContext(store, FIXTURE_DIR, 'user');
    for (const item of result.items) {
      expect(['full', 'no_source', 'signature_only']).toContain(item.detail);
      expect(item.tokens).toBeGreaterThan(0);
    }
  });
});

describe('tokenizeDescription', () => {
  it('splits camelCase', () => {
    const tokens = tokenizeDescription('userController');
    expect(tokens).toContain('user');
    expect(tokens).toContain('controller');
  });

  it('splits snake_case', () => {
    const tokens = tokenizeDescription('user_controller');
    expect(tokens).toContain('user');
    expect(tokens).toContain('controller');
  });

  it('removes stopwords', () => {
    const tokens = tokenizeDescription('the user and the post');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('and');
    expect(tokens).toContain('user');
    expect(tokens).toContain('post');
  });

  it('returns empty for stopwords-only input', () => {
    const tokens = tokenizeDescription('the and or a');
    expect(tokens).toHaveLength(0);
  });

  it('deduplicates tokens', () => {
    const tokens = tokenizeDescription('user User USER');
    expect(tokens.filter((t) => t === 'user')).toHaveLength(1);
  });
});
