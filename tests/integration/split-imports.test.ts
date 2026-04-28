/**
 * Regression test: multiple import statements from the same module
 * must have their specifiers consolidated into a single edge.
 *
 * Bug: INSERT OR IGNORE silently dropped the second import's specifiers
 * when two import statements targeted the same module.
 */

import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

function setupPipeline(fixturePath: string) {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

  const config = TraceMcpConfigSchema.parse({
    include: ['**/*.ts'],
    exclude: ['node_modules/**'],
  });

  const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
  return { store, pipeline };
}

describe('split import specifier consolidation', () => {
  const fixturePath = path.resolve(__dirname, '../fixtures/ts-split-imports');
  let store: Store;

  beforeEach(async () => {
    const setup = setupPipeline(fixturePath);
    store = setup.store;
    await setup.pipeline.indexAll();
  });

  it('merges specifiers from multiple import statements of the same module', () => {
    const edges = store.getEdgesByType('imports');

    // Find the consumer → errors edge via metadata.from
    const consumerToErrors = edges.find((e) => {
      const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata;
      if (!meta?.from?.includes('errors')) return false;
      // Verify source is consumer.ts via node ref
      const ref = store.getNodeRef(e.source_node_id);
      if (!ref) return false;
      const file = store.getFileById(ref.refId);
      return file?.path.includes('consumer');
    });

    expect(consumerToErrors).toBeDefined();

    const metadata =
      typeof consumerToErrors!.metadata === 'string'
        ? JSON.parse(consumerToErrors!.metadata)
        : consumerToErrors!.metadata;

    // All three specifiers from the three separate import statements must be present
    expect(metadata.specifiers).toBeDefined();
    expect(metadata.specifiers).toContain('MyResult');
    expect(metadata.specifiers).toContain('configError');
    expect(metadata.specifiers).toContain('dbError');
  });
});
