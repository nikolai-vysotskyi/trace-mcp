/**
 * Tree-sitter E2E integration test.
 * Indexes the tree-sitter-app fixture and verifies parser usage detection.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TreeSitterPlugin } from '../../src/indexer/plugins/integration/tooling/tree-sitter/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/tree-sitter-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Tree-sitter E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new TreeSitterPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('detects tree-sitter parser usage', () => {
    const files = store.getAllFiles();
    const tsFiles = files.filter(
      (f) => f.framework_role === 'tree_sitter_parser' || f.framework_role === 'tree_sitter_client',
    );
    expect(tsFiles.length).toBeGreaterThan(0);
  });
});
