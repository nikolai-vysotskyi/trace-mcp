/**
 * Pino E2E integration test.
 * Indexes the pino-app fixture and verifies logger detection.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PinoPlugin } from '../../src/indexer/plugins/integration/tooling/pino/index.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/pino-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Pino E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new PinoPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('detects logger config file', () => {
    const files = store.getAllFiles();
    const loggerFiles = files.filter((f) => f.framework_role === 'logger_config');
    expect(loggerFiles.length).toBeGreaterThan(0);
  });

  it('detects logger usage files', () => {
    const files = store.getAllFiles();
    const usageFiles = files.filter(
      (f) => f.framework_role === 'logger_usage' || f.framework_role === 'logger_child',
    );
    expect(usageFiles.length).toBeGreaterThan(0);
  });
});
