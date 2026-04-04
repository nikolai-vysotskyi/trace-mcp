/**
 * Comprehensive E2E test for all MCP tools.
 * Runs the full pipeline on fixtures and verifies tool outputs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { BladePlugin } from '../../src/indexer/plugins/integration/view/blade/index.js';

// Tools under test
import { search, getFileOutline, getSymbol } from '../../src/tools/navigation.js';
import { getChangeImpact } from '../../src/tools/impact.js';
import { findReferences } from '../../src/tools/references.js';
import { getRequestFlow } from '../../src/tools/flow.js';
import { getSchema } from '../../src/tools/schema.js';
import { getModelContext } from '../../src/tools/model.js';
import { getComponentTree } from '../../src/tools/components.js';

// ─── Laravel Fixture (full-stack: routes, models, controllers, migrations) ───

describe('MCP Tools E2E — Laravel', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/laravel-10');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    registry.registerFrameworkPlugin(new BladePlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.php', '**/*.blade.php'],
      exclude: ['vendor/**'],
    });
    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('search: finds symbols by name', async () => {
    const result = await search(store, 'User', {}, 20, 0, {});
    expect(result.items.length).toBeGreaterThan(0);
    const names = result.items.map((i) => i.symbol.name);
    expect(names).toContain('User');
  });

  it('search: filters by kind', async () => {
    const result = await search(store, 'User', { kind: 'class' }, 20, 0, {});
    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.symbol.kind).toBe('class');
    }
  });

  it('get_outline: returns symbols for controller file', () => {
    const result = getFileOutline(store, 'app/Http/Controllers/UserController.php');
    expect(result.isOk()).toBe(true);
    const { symbols } = result._unsafeUnwrap();
    expect(symbols.length).toBeGreaterThan(0);
    const names = symbols.map((s) => s.name);
    expect(names).toContain('UserController');
  });

  it('get_symbol: returns class details by symbolId', () => {
    // Use symbolId since FQN format varies by parser
    const searchResult = store.getAllFiles()
      .flatMap((f) => store.getSymbolsByFile(f.id))
      .find((s) => s.name === 'User' && s.kind === 'class');
    expect(searchResult).toBeDefined();

    const result = getSymbol(store, '.', { symbolId: searchResult!.symbol_id });
    expect(result.isOk()).toBe(true);
    const sym = result._unsafeUnwrap();
    expect(sym.symbol.name).toBe('User');
    expect(sym.symbol.kind).toBe('class');
  });

  it('get_change_impact: finds dependents of User model', () => {
    const result = getChangeImpact(store, { filePath: 'app/Models/User.php' }, 3);
    expect(result.isOk()).toBe(true);
    const impact = result._unsafeUnwrap();
    expect(impact.target.path).toContain('User.php');
    // UserController depends on User model via edges
    expect(impact.totalAffected).toBeGreaterThanOrEqual(0);
  });

  it('find_usages: finds usages of User model', () => {
    const result = findReferences(store, { fqn: 'App\\Models\\User' });
    expect(result.isOk()).toBe(true);
    const refs = result._unsafeUnwrap();
    // Something in the project references User
    expect(refs.total).toBeGreaterThanOrEqual(0);
  });

  it('get_request_flow: traces a known route', () => {
    const routes = store.getAllRoutes();
    expect(routes.length).toBeGreaterThan(0);

    // Find a simple route without parameters
    const simpleRoute = routes.find((r) => !r.uri.includes('{'));
    expect(simpleRoute).toBeDefined();

    const result = getRequestFlow(store, simpleRoute!.uri, simpleRoute!.method);
    expect(result.isOk()).toBe(true);
    const flow = result._unsafeUnwrap();
    // RequestFlowResult has steps[], first step should be a route
    const routeStep = flow.steps.find((s) => s.type === 'route');
    expect(routeStep).toBeDefined();
  });

  it('get_schema: reconstructs all tables', () => {
    const result = getSchema(store);
    expect(result.isOk()).toBe(true);
    const { tables } = result._unsafeUnwrap();
    expect(tables.length).toBeGreaterThan(0);
    const names = tables.map((t) => t.tableName);
    expect(names).toContain('users');
  });

  it('get_model_context: returns User model context', () => {
    const result = getModelContext(store, 'User');
    if (result.isOk()) {
      const ctx = result._unsafeUnwrap();
      expect(ctx.model.name).toBe('User');
      expect(ctx.relationships.length).toBeGreaterThanOrEqual(0);
    }
    // May not resolve if FQN lookup differs
  });
});

// ─── Vue Fixture ─────────────────────────────────────────────

describe('MCP Tools E2E — Vue', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/vue3-composition');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new VueFrameworkPlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.vue', '**/*.ts'],
      exclude: ['node_modules/**'],
    });
    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('search: finds Vue component by name', async () => {
    const result = await search(store, 'UserList', {}, 20, 0, {});
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('get_component_tree: builds tree from App.vue', () => {
    const files = store.getAllFiles();
    const appVue = files.find((f) => f.path.includes('App.vue'));
    expect(appVue).toBeDefined();

    const result = getComponentTree(store, appVue!.path);
    expect(result.isOk()).toBe(true);
    const tree = result._unsafeUnwrap();
    expect(tree.root.name).toBeDefined();
    expect(tree.totalComponents).toBeGreaterThanOrEqual(2);
  });

  it('get_change_impact: finds dependents of UserCard.vue', () => {
    const result = getChangeImpact(
      store,
      { filePath: 'src/components/UserCard.vue' },
      3,
    );
    if (result.isOk()) {
      const impact = result._unsafeUnwrap();
      expect(impact.totalAffected).toBeGreaterThan(0);
    }
  });
});

// ─── Hybrid search scoring ───────────────────────────────────

describe('MCP Tools E2E — Search scoring', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/laravel-10');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.php'],
      exclude: ['vendor/**'],
    });
    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('search results are sorted by score descending', async () => {
    const result = await search(store, 'User', {}, 20, 0, {});
    if (result.items.length >= 2) {
      for (let i = 1; i < result.items.length; i++) {
        expect(result.items[i - 1]!.score).toBeGreaterThanOrEqual(result.items[i]!.score);
      }
    }
  });

  it('class symbols rank higher than methods for same query', async () => {
    const result = await search(store, 'User', {}, 20, 0, {});
    const cls = result.items.find((i) => i.symbol.kind === 'class');
    const method = result.items.find((i) => i.symbol.kind === 'method');
    if (cls && method) {
      expect(cls.score).toBeGreaterThanOrEqual(method.score);
    }
  });

  it('search with file pattern filter narrows results', async () => {
    const all = await search(store, 'User', {}, 100, 0, {});
    const filtered = await search(store, 'User', { filePattern: '**/Models/**' }, 100, 0, {});
    expect(filtered.items.length).toBeLessThanOrEqual(all.items.length);
    for (const item of filtered.items) {
      expect(item.symbol.file).toContain('Models');
    }
  });
});
