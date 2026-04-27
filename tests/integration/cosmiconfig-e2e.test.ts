/**
 * Cosmiconfig E2E integration test.
 * Indexes the cosmiconfig-app fixture and verifies config loading detection.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { CosmiconfigPlugin } from '../../src/indexer/plugins/integration/tooling/cosmiconfig/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/cosmiconfig-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Cosmiconfig E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new CosmiconfigPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('detects config loader files', () => {
    const files = store.getAllFiles();
    const configFiles = files.filter(
      (f) => f.framework_role === 'config_loader' || f.framework_role === 'env_loader',
    );
    expect(configFiles.length).toBeGreaterThan(0);
  });
});
