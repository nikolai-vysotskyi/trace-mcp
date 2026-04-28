/**
 * Raw SQL E2E integration test.
 * Indexes the raw-sql-app fixture and verifies SQL statement extraction.
 */

import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { RawSqlPlugin } from '../../src/indexer/plugins/integration/orm/raw-sql/index.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/raw-sql-app');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['src/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Raw SQL E2E', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new RawSqlPlugin());

    const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes fixture files', () => {
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThan(0);
  });

  it('sets framework role for SQL files', () => {
    const files = store.getAllFiles();
    const sqlFiles = files.filter(
      (f) => f.framework_role === 'sql_schema' || f.framework_role === 'sql_queries',
    );
    expect(sqlFiles.length).toBeGreaterThan(0);
  });

  it('detects DDL schema definitions', () => {
    const files = store.getAllFiles();
    const schemaFiles = files.filter((f) => f.framework_role === 'sql_schema');
    expect(schemaFiles.length).toBeGreaterThan(0);
  });
});
