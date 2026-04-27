/**
 * Build tools E2E integration test.
 * Indexes the build-tools-app fixture and verifies build config extraction.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { BuildToolsPlugin } from '../../src/indexer/plugins/integration/tooling/build-tools/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/build-tools-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Build tools E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new BuildToolsPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('detects build config files', () => {
    const files = store.getAllFiles();
    const buildFiles = files.filter((f) => f.framework_role === 'build_config');
    expect(buildFiles.length).toBeGreaterThan(0);
  });
});
