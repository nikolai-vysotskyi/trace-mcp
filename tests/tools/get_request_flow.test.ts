import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../src/indexer/plugins/language/php/index.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { getRequestFlow } from '../../src/tools/framework/flow.js';
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

describe('get_request_flow', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
    await pipeline.indexAll();
  });

  it('traces GET /users to UserController@index', () => {
    const result = getRequestFlow(store, '/users', 'GET');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const flow = result.value;
    expect(flow.method).toBe('GET');
    expect(flow.url).toBe('/users');

    // Should have route step
    const routeStep = flow.steps.find((s) => s.type === 'route');
    expect(routeStep).toBeDefined();

    // Should have controller step
    const controllerStep = flow.steps.find((s) => s.type === 'controller');
    expect(controllerStep).toBeDefined();
    expect(controllerStep!.name).toContain('index');
  });

  it('traces POST /users with controller', () => {
    const result = getRequestFlow(store, '/users', 'POST');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    const flow = result.value;

    // Should have controller step referencing store action
    const controllerStep = flow.steps.find((s) => s.type === 'controller');
    expect(controllerStep).toBeDefined();
    expect(controllerStep!.name).toContain('store');

    // The route comes from either web.php (has 'auth' middleware) or api.php (has 'auth:sanctum')
    // Both are valid; we just verify the flow has at least route + controller
    expect(flow.steps.filter((s) => s.type === 'route')).toHaveLength(1);
  });

  it('returns NOT_FOUND for unknown URL', () => {
    const result = getRequestFlow(store, '/nonexistent', 'GET');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });
});
