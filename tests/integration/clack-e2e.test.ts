/**
 * Clack E2E integration test.
 * Indexes the clack-app fixture and verifies interactive prompt detection.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { ClackPlugin } from '../../src/indexer/plugins/integration/tooling/clack/index.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/clack-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Clack E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new ClackPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('detects CLI wizard files', () => {
    const files = store.getAllFiles();
    const wizardFiles = files.filter(
      (f) =>
        f.framework_role === 'cli_wizard' ||
        f.framework_role === 'cli_prompts' ||
        f.framework_role === 'cli_interactive',
    );
    expect(wizardFiles.length).toBeGreaterThan(0);
  });

  it('identifies wizard with intro/outro flow', () => {
    const files = store.getAllFiles();
    const wizardFiles = files.filter((f) => f.framework_role === 'cli_wizard');
    expect(wizardFiles.length).toBeGreaterThan(0);
  });
});
