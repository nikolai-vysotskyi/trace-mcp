import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { search, getSymbol, getFileOutline } from '../../src/tools/navigation/navigation.js';
import type { TraceMcpConfig } from '../../src/config.js';

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

describe('Navigation tools', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();
  });

  describe('search()', () => {
    it('finds symbols by name', async () => {
      const result = await search(store, 'User');
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.some((r) => r.symbol.name === 'User')).toBe(true);
    });

    it('finds functions by name', async () => {
      const result = await search(store, 'add');
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items.some((r) => r.symbol.name === 'add')).toBe(true);
    });

    it('filters by kind', async () => {
      const result = await search(store, 'User', { kind: 'class' });
      for (const item of result.items) {
        expect(item.symbol.kind).toBe('class');
      }
    });

    it('filters by language', async () => {
      const result = await search(store, 'User', { language: 'php' });
      for (const item of result.items) {
        expect(item.file.language).toBe('php');
      }
    });

    it('returns scored results sorted by score', async () => {
      const result = await search(store, 'User');
      for (let i = 1; i < result.items.length; i++) {
        expect(result.items[i - 1].score).toBeGreaterThanOrEqual(result.items[i].score);
      }
    });

    it('returns empty for nonsense query', async () => {
      const result = await search(store, 'zzzxyznonexistent999');
      expect(result.items).toHaveLength(0);
    });

    it('supports pagination with limit/offset', async () => {
      const all = await search(store, 'User', undefined, 100, 0);
      if (all.items.length >= 2) {
        const page1 = await search(store, 'User', undefined, 1, 0);
        const page2 = await search(store, 'User', undefined, 1, 1);
        expect(page1.items[0].symbol.symbol_id).not.toBe(page2.items[0].symbol.symbol_id);
      }
    });
  });

  describe('getSymbol()', () => {
    it('returns symbol source by symbol_id', async () => {
      // First find a symbol
      const searchResult = await search(store, 'add');
      expect(searchResult.items.length).toBeGreaterThan(0);

      const symbolId = searchResult.items[0].symbol.symbol_id;
      const result = getSymbol(store, FIXTURE_DIR, { symbolId });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.source).toBeTruthy();
        expect(result.value.symbol.symbol_id).toBe(symbolId);
      }
    });

    it('returns symbol source by FQN', () => {
      const result = getSymbol(store, FIXTURE_DIR, { fqn: 'App\\Models\\User' });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.symbol.name).toBe('User');
        expect(result.value.source).toContain('class User');
      }
    });

    it('returns NOT_FOUND for unknown symbol_id', () => {
      const result = getSymbol(store, FIXTURE_DIR, { symbolId: 'nonexistent' });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('getFileOutline()', () => {
    it('returns symbols for a known file', () => {
      const result = getFileOutline(store, 'app/Models/User.php');
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.symbols.length).toBeGreaterThan(0);
        expect(result.value.language).toBe('php');
      }
    });

    it('returns signatures without source bodies', () => {
      const result = getFileOutline(store, 'src/utils.ts');
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        for (const sym of result.value.symbols) {
          // Outline should have signature (if available) but the object
          // does not contain a `source` field
          expect(sym).not.toHaveProperty('source');
          expect(sym).toHaveProperty('signature');
        }
      }
    });

    it('returns NOT_FOUND for unknown file', () => {
      const result = getFileOutline(store, 'nonexistent.php');
      expect(result.isErr()).toBe(true);
    });
  });
});
