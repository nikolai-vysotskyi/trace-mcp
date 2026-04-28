/**
 * Commander E2E integration test.
 * Indexes the commander-app fixture and verifies CLI command extraction.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { CommanderPlugin } from '../../src/indexer/plugins/integration/tooling/commander/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/commander-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Commander E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new CommanderPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('extracts CLI commands as routes', () => {
    const routes = store.getAllRoutes();
    const cliRoutes = routes.filter((r) => r.method === 'CLI');
    expect(cliRoutes.length).toBeGreaterThanOrEqual(3);
    const names = cliRoutes.map((r) => r.uri);
    expect(names).toContain('init');
    expect(names).toContain('build');
    expect(names).toContain('deploy');
  });

  it('sets framework role on CLI files', () => {
    const files = store.getAllFiles();
    const cliFiles = files.filter(
      (f) => f.framework_role === 'cli_command' || f.framework_role === 'cli_entry',
    );
    expect(cliFiles.length).toBeGreaterThan(0);
  });
});
