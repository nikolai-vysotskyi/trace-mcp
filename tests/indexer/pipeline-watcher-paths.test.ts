/**
 * Watcher-path batch hygiene: `indexFiles()` is the event-driven entry point
 * (watcher live events, hooks, `register_edit`, HTTP reindex-file). Batches
 * arriving here can name directories (a watcher reports the dir alongside —
 * or instead of — its contents), and those must be skipped, never counted
 * as indexing errors.
 *
 * Live evidence (installed daemon 3.27.1, 2026-09-18): an 85-file batch with
 * 18 directory paths completed as `{ indexed: 67, errors: 18 }` with eighteen
 * `Cannot read file` warns — and retried with the same 18 errors. TRA-1649.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { search } from '../../src/tools/navigation/navigation.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

describe('indexFiles() — directory entries in the batch', () => {
  let root: string;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeAll(async () => {
    root = createTmpFixture(
      {
        'src/alpha.ts': 'export function alpha() { return 1; }\n',
        'sub/nested.ts': 'export function nested() { return 2; }\n',
      },
      'trace-mcp-watcher-dirs-',
    );
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.ts'],
      exclude: ['node_modules/**'],
    });
    pipeline = new IndexingPipeline(store, registry, config, root);
  }, 120_000);

  afterAll(() => removeTmpDir(root));

  it('indexes the real file in a mixed batch', async () => {
    const result = await pipeline.indexFiles(['src/alpha.ts', 'sub']);
    expect(result.indexed).toBeGreaterThanOrEqual(1);
    const found = await search(store, 'alpha', { kind: 'function' }, 10, 0, {});
    expect(found.items.map((i) => i.symbol.name)).toContain('alpha');
  });

  it.fails('directories are skipped without counting errors (TRA-1649)', async () => {
    const result = await pipeline.indexFiles(['src/alpha.ts', 'sub']);
    expect(result.errors).toBe(0);
    const paths = store.getAllFiles().map((f) => f.path);
    expect(paths.some((p) => p === 'sub')).toBe(false);
  });
});
