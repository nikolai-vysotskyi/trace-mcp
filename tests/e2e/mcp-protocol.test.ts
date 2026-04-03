import { describe, it, expect, beforeEach } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { getIndexHealth, getProjectMap } from '../../src/tools/project.js';
import { search, getFileOutline } from '../../src/tools/navigation.js';
import type { TraceMcpConfig } from '../../src/config.js';

function makeConfig(): TraceMcpConfig {
  return {
    root: '.',
    include: ['**/*.php', '**/*.ts'],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

function setup() {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const registry = new PluginRegistry();
  const config = makeConfig();
  return { db, store, registry, config };
}

describe('MCP Protocol E2E', () => {
  let store: Store;
  let registry: PluginRegistry;
  let config: TraceMcpConfig;

  beforeEach(() => {
    const ctx = setup();
    store = ctx.store;
    registry = ctx.registry;
    config = ctx.config;
  });

  describe('get_index_health', () => {
    it('returns correct structure for empty index', () => {
      const result = getIndexHealth(store, config);
      expect(result.status).toBe('empty');
      expect(result.stats).toBeDefined();
      expect(result.stats.totalFiles).toBe(0);
      expect(result.schemaVersion).toBeGreaterThan(0);
      expect(result.config.dbPath).toBe(':memory:');
      expect(Array.isArray(result.warnings)).toBe(true);
    });

    it('returns ok status when files are indexed', () => {
      store.insertFile('test.php', 'php', 'abc123', 100);
      const result = getIndexHealth(store, config);
      expect(result.status).toBe('ok');
      expect(result.stats.totalFiles).toBe(1);
    });
  });

  describe('get_project_map', () => {
    it('returns project map with empty index', () => {
      const result = getProjectMap(store, registry);
      expect(result.stats).toBeDefined();
      expect(Array.isArray(result.frameworks)).toBe(true);
      expect(Array.isArray(result.languages)).toBe(true);
    });

    it('includes language breakdown', () => {
      store.insertFile('a.php', 'php', 'h1', 50);
      store.insertFile('b.php', 'php', 'h2', 60);
      store.insertFile('c.ts', 'typescript', 'h3', 70);

      const result = getProjectMap(store, registry);
      expect(result.languages.length).toBeGreaterThanOrEqual(2);

      const php = result.languages.find((l) => l.language === 'php');
      expect(php).toBeDefined();
      expect(php!.count).toBe(2);
    });
  });

  describe('search', () => {
    it('returns results for matching symbols', async () => {
      const fileId = store.insertFile('app/User.php', 'php', 'h1', 100);
      store.insertSymbol(fileId, {
        symbolId: 'app/User.php::User#class',
        name: 'User',
        kind: 'class',
        fqn: 'App\\Models\\User',
        byteStart: 0,
        byteEnd: 100,
      });

      const result = await search(store, 'User', {}, 20, 0, {});
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.items[0]!.symbol.name).toBe('User');
    });

    it('returns empty results for no match', async () => {
      const result = await search(store, 'nonexistent_xyzzy', {}, 20, 0, {});
      expect(result.items).toHaveLength(0);
    });
  });

  describe('get_file_outline', () => {
    it('returns symbols for a known file', () => {
      const fileId = store.insertFile('app/User.php', 'php', 'h1', 100);
      store.insertSymbol(fileId, {
        symbolId: 'app/User.php::User#class',
        name: 'User',
        kind: 'class',
        byteStart: 0,
        byteEnd: 100,
        lineStart: 1,
        lineEnd: 50,
      });

      const result = getFileOutline(store, 'app/User.php');
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.symbols.length).toBeGreaterThan(0);
      }
    });

    it('returns error for unknown file', () => {
      const result = getFileOutline(store, 'nonexistent.php');
      expect(result.isErr()).toBe(true);
    });
  });
});
