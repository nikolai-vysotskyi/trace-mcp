/**
 * Integration: Nuxt 3 file-based routing through full pipeline.
 * Verifies that pages/ files generate routes and server/api/ files
 * generate API routes with correct HTTP methods.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { NuxtPlugin } from '../../src/indexer/plugins/integration/framework/nuxt/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { VueLanguagePlugin } from '../../src/indexer/plugins/language/vue/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

describe('Nuxt file-based routing e2e', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/nuxt3');
    store = createTestStore();
    const registry = new PluginRegistry();

    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerLanguagePlugin(new VueLanguagePlugin());
    registry.registerFrameworkPlugin(new NuxtPlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.vue', '**/*.ts'],
      exclude: ['node_modules/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('indexes Nuxt files', () => {
    const stats = store.getStats();
    expect(stats.totalFiles).toBeGreaterThanOrEqual(3);
  });

  it('creates routes from pages/index.vue', () => {
    const routes = store.getAllRoutes();
    const root = routes.find((r) => r.uri === '/');
    expect(root).toBeDefined();
    expect(root!.method).toBe('GET');
  });

  it('creates dynamic route from pages/users/[id].vue', () => {
    const routes = store.getAllRoutes();
    const dynamic = routes.find((r) => r.uri.includes(':id'));
    expect(dynamic).toBeDefined();
    expect(dynamic!.uri).toBe('/users/:id');
  });

  it('creates API route from server/api/users.get.ts', () => {
    const routes = store.getAllRoutes();
    const apiRoute = routes.find((r) => r.uri.includes('api/users'));
    expect(apiRoute).toBeDefined();
    expect(apiRoute!.method).toBe('GET');
  });
});
