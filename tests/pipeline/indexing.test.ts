import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline, type IndexingResult } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/no-framework');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: [
      'app/**/*.php',
      'src/**/*.ts',
      'components/**/*.vue',
    ],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

function setup() {
  const db = initializeDatabase(':memory:');
  const store = new Store(db);
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new PhpLanguagePlugin());
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  registry.registerLanguagePlugin(new VueLanguagePlugin());

  const config = makeConfig();
  const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
  return { db, store, registry, config, pipeline };
}

describe('IndexingPipeline', () => {
  let store: Store;
  let pipeline: IndexingPipeline;
  let db: ReturnType<typeof initializeDatabase>;

  beforeEach(() => {
    const ctx = setup();
    store = ctx.store;
    pipeline = ctx.pipeline;
    db = ctx.db;
  });

  it('indexes all files in fixture and creates files + symbols', async () => {
    const result = await pipeline.indexAll();

    expect(result.totalFiles).toBeGreaterThan(0);
    expect(result.indexed).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Check files were stored
    const files = store.getAllFiles();
    expect(files.length).toBe(result.indexed);

    // Check symbols were created
    const stats = store.getStats();
    expect(stats.totalSymbols).toBeGreaterThan(0);
  });

  it('creates PHP symbols from fixture', async () => {
    await pipeline.indexAll();

    const userFile = store.getFile('app/Models/User.php');
    expect(userFile).toBeDefined();

    const symbols = store.getSymbolsByFile(userFile!.id);
    const classSymbol = symbols.find((s) => s.kind === 'class' && s.name === 'User');
    expect(classSymbol).toBeDefined();
    expect(classSymbol!.fqn).toBe('App\\Models\\User');
  });

  it('creates TypeScript symbols from fixture', async () => {
    await pipeline.indexAll();

    const utilsFile = store.getFile('src/utils.ts');
    expect(utilsFile).toBeDefined();

    const symbols = store.getSymbolsByFile(utilsFile!.id);
    const addFn = symbols.find((s) => s.name === 'add');
    expect(addFn).toBeDefined();
    expect(addFn!.kind).toBe('function');
  });

  it('creates Vue symbols from fixture', async () => {
    await pipeline.indexAll();

    const vueFile = store.getFile('components/UserCard.vue');
    expect(vueFile).toBeDefined();

    const symbols = store.getSymbolsByFile(vueFile!.id);
    expect(symbols.length).toBeGreaterThan(0);
  });

  it('skips unchanged files on incremental reindex', async () => {
    const first = await pipeline.indexAll();
    expect(first.indexed).toBeGreaterThan(0);

    // Re-run without force
    const second = await pipeline.indexAll(false);
    expect(second.skipped).toBe(first.indexed);
    expect(second.indexed).toBe(0);
  });

  it('re-indexes all files when force=true', async () => {
    const first = await pipeline.indexAll();
    const indexedCount = first.indexed;

    const forced = await pipeline.indexAll(true);
    expect(forced.indexed).toBe(indexedCount);
    expect(forced.skipped).toBe(0);
  });

  it('indexes specific files via indexFiles()', async () => {
    const result = await pipeline.indexFiles(['app/Models/User.php']);

    expect(result.totalFiles).toBe(1);
    expect(result.indexed).toBe(1);

    const file = store.getFile('app/Models/User.php');
    expect(file).toBeDefined();
  });
});
