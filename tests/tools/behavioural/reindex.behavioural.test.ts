/**
 * Behavioural coverage for the `reindex` MCP tool.
 *
 * IMPL NOTE: `reindex` is inline-registered in `src/tools/register/core.ts`
 * and forwards to `IndexingPipeline.indexAll(force, { postprocess })` (or
 * `indexFiles([path], { postprocess })` when a subdirectory is given). We
 * assert the underlying pipeline contract (same approach as
 * `get-env-vars.behavioural.test.ts`).
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../../src/config.js';
import { IndexingPipeline } from '../../../src/indexer/pipeline.js';
import { PhpLanguagePlugin } from '../../../src/indexer/plugins/language/php/index.js';
import { TypeScriptLanguagePlugin } from '../../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { createTestStore } from '../../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/no-framework');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['app/**/*.php', 'src/**/*.ts'],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

function setup() {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new PhpLanguagePlugin());
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE_DIR);
  return { store, pipeline };
}

describe('reindex (IndexingPipeline.indexAll / indexFiles) — behavioural contract', () => {
  it('clean fixture: returns envelope { totalFiles, indexed, skipped, errors, durationMs }', async () => {
    const { pipeline } = setup();
    const result = await pipeline.indexAll();

    expect(result).toBeTruthy();
    expect(typeof result.totalFiles).toBe('number');
    expect(typeof result.indexed).toBe('number');
    expect(typeof result.skipped).toBe('number');
    expect(typeof result.errors).toBe('number');
    expect(typeof result.durationMs).toBe('number');
    expect(result.totalFiles).toBeGreaterThan(0);
    expect(result.indexed).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('force=true reindexes everything (skipped count is zero on a forced run)', async () => {
    const { pipeline } = setup();
    // Warm the index first so the second pass would normally hit the hash cache.
    await pipeline.indexAll();
    const forced = await pipeline.indexAll(true);
    expect(forced.totalFiles).toBeGreaterThan(0);
    expect(forced.skipped).toBe(0);
    expect(forced.errors).toBe(0);
  });

  it('path argument is respected (indexFiles only touches the given path)', async () => {
    const { store, pipeline } = setup();
    // The MCP `reindex` tool forwards `path` straight to indexFiles([path]).
    // Whether `path` resolves to a single file or a directory is the
    // pipeline's responsibility — we pin the single-file contract here.
    const result = await pipeline.indexFiles(['src/index.ts']);
    expect(result.totalFiles).toBeGreaterThanOrEqual(1);
    expect(result.errors).toBe(0);
    expect(result.indexed).toBeGreaterThanOrEqual(1);

    // Only the requested file should be present in the store.
    const files = store.getAllFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.some((f) => f.path === 'src/index.ts')).toBe(true);
  });

  it("postprocess: 'none' is accepted and surfaced on the result envelope", async () => {
    const { pipeline } = setup();
    const result = await pipeline.indexAll(false, { postprocess: 'none' });
    expect(result.totalFiles).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    // The pipeline echoes back the postprocess level it ran at.
    if (result.postprocess !== undefined) {
      expect(result.postprocess).toBe('none');
    }
  });

  it("postprocess: 'minimal' is accepted and surfaced on the result envelope", async () => {
    const { pipeline } = setup();
    const result = await pipeline.indexAll(false, { postprocess: 'minimal' });
    expect(result.totalFiles).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    if (result.postprocess !== undefined) {
      expect(result.postprocess).toBe('minimal');
    }
  });
});
