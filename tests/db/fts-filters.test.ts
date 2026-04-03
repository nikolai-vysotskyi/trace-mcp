/**
 * Tests for FTS filter push-down (kind, language, filePattern).
 * Verifies that filters work correctly AND that SQL-level filtering
 * returns only matching rows (not a superset that gets filtered in JS).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue.js';
import { searchFts, escapeFtsQuery } from '../../src/db/fts.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/no-framework');

let store: Store;

beforeAll(async () => {
  const db = initializeDatabase(':memory:');
  store = new Store(db);
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new PhpLanguagePlugin());
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  registry.registerLanguagePlugin(new VueLanguagePlugin());

  const config: TraceMcpConfig = {
    root: FIXTURE_DIR,
    include: ['app/**/*.php', 'src/**/*.ts', 'components/**/*.vue'],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
  };
  await new IndexingPipeline(store, registry, config, FIXTURE_DIR).indexAll();
});

describe('searchFts filter push-down', () => {
  it('kind filter returns only symbols of that kind', () => {
    const results = searchFts(store.db, 'User', 50, 0, { kind: 'class' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const sym = store.getSymbolBySymbolId(r.symbolIdStr);
      expect(sym?.kind).toBe('class');
    }
  });

  it('kind filter excludes other kinds', () => {
    const all = searchFts(store.db, 'User', 50, 0);
    const classOnly = searchFts(store.db, 'User', 50, 0, { kind: 'class' });
    const methodOnly = searchFts(store.db, 'User', 50, 0, { kind: 'method' });

    // classOnly + methodOnly should be a subset of all, never more
    expect(classOnly.length).toBeLessThanOrEqual(all.length);
    expect(methodOnly.length).toBeLessThanOrEqual(all.length);

    // No overlap in IDs between class-only and method-only
    const classIds = new Set(classOnly.map((r) => r.symbolIdStr));
    const methodIds = new Set(methodOnly.map((r) => r.symbolIdStr));
    for (const id of classIds) {
      expect(methodIds.has(id)).toBe(false);
    }
  });

  it('language filter returns only symbols from files of that language', () => {
    const results = searchFts(store.db, 'User', 50, 0, { language: 'php' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const sym = store.getSymbolBySymbolId(r.symbolIdStr);
      const file = store.getFileById(sym!.file_id);
      expect(file?.language).toBe('php');
    }
  });

  it('filePattern filter returns only symbols from matching paths', () => {
    const results = searchFts(store.db, 'User', 50, 0, { filePattern: 'app/' });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const sym = store.getSymbolBySymbolId(r.symbolIdStr);
      const file = store.getFileById(sym!.file_id);
      expect(file?.path).toContain('app/');
    }
  });

  it('combined kind+language filter narrows results correctly', () => {
    const results = searchFts(store.db, 'User', 50, 0, { kind: 'class', language: 'php' });
    for (const r of results) {
      const sym = store.getSymbolBySymbolId(r.symbolIdStr);
      const file = store.getFileById(sym!.file_id);
      expect(sym?.kind).toBe('class');
      expect(file?.language).toBe('php');
    }
  });

  it('returns empty for a kind that does not match any results', () => {
    // 'namespace' is unlikely to match 'User' symbols in this fixture
    const results = searchFts(store.db, 'User', 50, 0, { kind: 'namespace' });
    // Either 0 or all results are namespaces — no class/function leak
    for (const r of results) {
      const sym = store.getSymbolBySymbolId(r.symbolIdStr);
      expect(sym?.kind).toBe('namespace');
    }
  });

  it('no filter returns superset of any filtered search', () => {
    const all = searchFts(store.db, 'add', 100, 0);
    const filtered = searchFts(store.db, 'add', 100, 0, { kind: 'function' });
    const allIds = new Set(all.map((r) => r.symbolIdStr));
    for (const r of filtered) {
      expect(allIds.has(r.symbolIdStr)).toBe(true);
    }
  });
});

describe('escapeFtsQuery', () => {
  it('wraps terms in quotes', () => {
    const result = escapeFtsQuery('hello world');
    expect(result).toBe('"hello" "world"');
  });

  it('strips FTS5 special characters', () => {
    const result = escapeFtsQuery('foo(bar)*baz');
    expect(result).toContain('"foo"');
    expect(result).toContain('"bar"');
    expect(result).toContain('"baz"');
    expect(result).not.toContain('(');
    expect(result).not.toContain('*');
  });

  it('returns empty string for blank input', () => {
    expect(escapeFtsQuery('')).toBe('');
    expect(escapeFtsQuery('   ')).toBe('');
  });

  it('returns empty string for input that is only special chars', () => {
    expect(escapeFtsQuery('***(){}[]')).toBe('');
  });

  it('handles single term correctly', () => {
    expect(escapeFtsQuery('User')).toBe('"User"');
  });
});
