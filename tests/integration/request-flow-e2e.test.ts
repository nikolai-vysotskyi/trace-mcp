/**
 * Integration test: get_request_flow end-to-end
 * Runs the full pipeline on laravel-10, then calls getRequestFlow
 * and verifies the COMPLETE chain: route → middleware → controller → FormRequest → events
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
import { LaravelPlugin } from '../../src/indexer/plugins/integration/laravel/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/vue/index.js';
import { InertiaPlugin } from '../../src/indexer/plugins/integration/inertia/index.js';
import { getRequestFlow } from '../../src/tools/flow.js';

describe('get_request_flow end-to-end (laravel-10)', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/laravel-10');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();

    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    registry.registerFrameworkPlugin(new VueFrameworkPlugin());
    registry.registerFrameworkPlugin(new InertiaPlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.php', '**/*.ts', '**/*.vue'],
      exclude: ['vendor/**', 'node_modules/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('traces GET /users → route → controller', () => {
    const result = getRequestFlow(store, '/users', 'GET');
    expect(result.isOk()).toBe(true);

    const flow = result._unsafeUnwrap();
    expect(flow.steps.length).toBeGreaterThanOrEqual(2);

    const routeStep = flow.steps.find((s) => s.type === 'route');
    expect(routeStep).toBeDefined();
    expect(routeStep!.details?.uri).toBe('/users');

    const controllerStep = flow.steps.find((s) => s.type === 'controller');
    expect(controllerStep).toBeDefined();
    expect(controllerStep!.fqn).toContain('UserController');
  });

  it('traces POST /users with middleware and FormRequest', () => {
    const result = getRequestFlow(store, '/users', 'POST');
    expect(result.isOk()).toBe(true);

    const flow = result._unsafeUnwrap();
    const stepTypes = flow.steps.map((s) => s.type);

    // Route step
    expect(stepTypes).toContain('route');

    // Should have middleware 'auth'
    const mwStep = flow.steps.find((s) => s.type === 'middleware');
    if (mwStep) {
      expect(mwStep.name).toBe('auth');
    }

    // Controller step
    const controllerStep = flow.steps.find((s) => s.type === 'controller');
    expect(controllerStep).toBeDefined();
    expect(controllerStep!.fqn).toContain('UserController');
    expect(controllerStep!.details?.action).toBe('store');

    // FormRequest step — validates_with edge should connect store() → StoreUserRequest
    const frStep = flow.steps.find((s) => s.type === 'form_request');
    expect(frStep).toBeDefined();
    expect(frStep!.fqn).toContain('StoreUserRequest');
  });

  it('returns NOT_FOUND for non-existent route', () => {
    const result = getRequestFlow(store, '/nonexistent', 'GET');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('NOT_FOUND');
  });
});

describe('get_request_flow end-to-end (inertia-laravel-vue)', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/inertia-laravel-vue');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();

    registry.registerLanguagePlugin(new PhpLanguagePlugin());
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new LaravelPlugin());
    registry.registerFrameworkPlugin(new VueFrameworkPlugin());
    registry.registerFrameworkPlugin(new InertiaPlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.php', '**/*.ts', '**/*.vue'],
      exclude: ['vendor/**', 'node_modules/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('traces GET /users → route → controller → Inertia Vue page', () => {
    const result = getRequestFlow(store, '/users', 'GET');
    expect(result.isOk()).toBe(true);

    const flow = result._unsafeUnwrap();
    const stepTypes = flow.steps.map((s) => s.type);

    expect(stepTypes).toContain('route');
    expect(stepTypes).toContain('controller');

    // Inertia page step — the key integration test
    const inertiaStep = flow.steps.find((s) => s.type === 'inertia_page');
    expect(inertiaStep).toBeDefined();
    expect(inertiaStep!.details?.pageName).toBe('Users/Index');
    expect(inertiaStep!.details?.filePath).toContain('Users/Index.vue');

    // Prop names should be extracted
    const propNames = inertiaStep!.details?.propNames as string[];
    expect(propNames).toBeDefined();
    expect(propNames).toContain('users');
    expect(propNames).toContain('filters');
  });

  it('traces GET /users/{user} → Inertia Users/Show page', () => {
    const result = getRequestFlow(store, '/users/{user}', 'GET');
    expect(result.isOk()).toBe(true);

    const flow = result._unsafeUnwrap();
    const inertiaStep = flow.steps.find((s) => s.type === 'inertia_page');
    expect(inertiaStep).toBeDefined();
    expect(inertiaStep!.details?.pageName).toBe('Users/Show');
    expect(inertiaStep!.details?.propNames).toContain('user');
    expect(inertiaStep!.details?.propNames).toContain('posts');
  });
});
