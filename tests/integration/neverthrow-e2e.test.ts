/**
 * Neverthrow E2E integration test.
 * Indexes the neverthrow-app fixture and verifies Result pattern detection.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { NeverthrowPlugin } from '../../src/indexer/plugins/integration/tooling/neverthrow/index.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/neverthrow-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Neverthrow E2E', () => {
  let store: Store;

  beforeAll(async () => {
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new NeverthrowPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('detects Result pattern usage', () => {
    const files = store.getAllFiles();
    const resultFiles = files.filter(
      (f) =>
        f.framework_role === 'result_chain' ||
        f.framework_role === 'result_boundary' ||
        f.framework_role === 'result_usage',
    );
    expect(resultFiles.length).toBeGreaterThan(0);
  });

  it('identifies files with fromPromise as result boundary', () => {
    const files = store.getAllFiles();
    const boundaryFiles = files.filter((f) => f.framework_role === 'result_boundary');
    expect(boundaryFiles.length).toBeGreaterThan(0);
  });
});
