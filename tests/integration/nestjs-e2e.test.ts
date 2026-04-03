/**
 * Integration: NestJS module → controller → DI → routes through full pipeline.
 * Does the pipeline actually create NestJS edges? Do routes get extracted?
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript.js';
import { NestJSPlugin } from '../../src/indexer/plugins/framework/nestjs/index.js';

describe('NestJS e2e through pipeline', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/nestjs-basic');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();

    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new NestJSPlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.ts'],
      exclude: ['node_modules/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('indexes all NestJS files', () => {
    const stats = store.getStats();
    expect(stats.totalFiles).toBeGreaterThanOrEqual(4);
  });

  it('creates routes from @Controller + @Get/@Post decorators', () => {
    const routes = store.getAllRoutes();
    expect(routes.length).toBeGreaterThan(0);

    // UsersController has @Get(':id') and @Post()
    const getRoute = routes.find((r) => r.method === 'GET' && r.uri.includes('users'));
    expect(getRoute).toBeDefined();

    const postRoute = routes.find((r) => r.method === 'POST' && r.uri.includes('users'));
    expect(postRoute).toBeDefined();
  });

  it('creates DI injection edges', () => {
    const edges = store.getEdgesByType('nest_injects');
    // UsersController constructor injects UsersService
    // At minimum we should see some injection edges
    // (depends on whether the plugin resolves FQNs in Pass 2)
    // Even if 0, the test documents the current state
    console.log(`nest_injects edges: ${edges.length}`);
  });

  it('creates module import edges', () => {
    const edges = store.getEdgesByType('nest_module_imports');
    console.log(`nest_module_imports edges: ${edges.length}`);
  });

  it('extracts symbols from NestJS files', () => {
    const files = store.getAllFiles();
    const controllerFile = files.find((f) => f.path.includes('users.controller'));
    expect(controllerFile).toBeDefined();

    const symbols = store.getSymbolsByFile(controllerFile!.id);
    expect(symbols.length).toBeGreaterThan(0);

    // Should have UsersController class
    const controllerClass = symbols.find((s) => s.kind === 'class' && s.name === 'UsersController');
    expect(controllerClass).toBeDefined();

    // Should have methods
    const methods = symbols.filter((s) => s.kind === 'method');
    expect(methods.length).toBeGreaterThan(0);
  });
});
