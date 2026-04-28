/**
 * Integration: NestJS module → controller → DI → routes through full pipeline.
 * Does the pipeline actually create NestJS edges? Do routes get extracted?
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { NestJSPlugin } from '../../src/indexer/plugins/integration/framework/nestjs/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

describe('NestJS e2e through pipeline', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/nestjs-basic');
    store = createTestStore();
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
    expect(edges.length).toBeGreaterThan(0);
  });

  it('creates module import edges', () => {
    const edges = store.getEdgesByType('nest_module_imports');
    // AppModule imports UsersModule
    expect(edges.length).toBeGreaterThan(0);
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
