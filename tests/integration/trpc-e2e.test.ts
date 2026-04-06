/**
 * tRPC E2E integration test.
 * Indexes the trpc-app fixture and verifies procedure extraction.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { TrpcPlugin } from '../../src/indexer/plugins/integration/api/trpc/index.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/trpc-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('tRPC E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new TrpcPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('extracts tRPC procedures as routes', () => {
    const routes = store.getAllRoutes();
    const trpcRoutes = routes.filter((r) =>
      r.method === 'QUERY' || r.method === 'MUTATION',
    );
    expect(trpcRoutes.length).toBeGreaterThan(0);
  });

  it('captures query procedures', () => {
    const routes = store.getAllRoutes();
    const queries = routes.filter((r) => r.method === 'QUERY');
    const names = queries.map((r) => r.uri);
    expect(names.some((n) => n.includes('getById') || n.includes('list') || n.includes('feed'))).toBe(true);
  });

  it('captures mutation procedures', () => {
    const routes = store.getAllRoutes();
    const mutations = routes.filter((r) => r.method === 'MUTATION');
    expect(mutations.length).toBeGreaterThan(0);
  });

  it('sets framework role on router files', () => {
    const files = store.getAllFiles();
    const trpcFiles = files.filter((f) =>
      f.framework_role === 'trpc_router' || f.framework_role === 'trpc_procedure',
    );
    expect(trpcFiles.length).toBeGreaterThan(0);
  });
});
