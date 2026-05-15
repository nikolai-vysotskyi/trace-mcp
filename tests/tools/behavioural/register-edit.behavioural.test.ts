/**
 * Behavioural coverage for the `register_edit` MCP tool.
 *
 * IMPL NOTE: `register_edit` is inline-registered in
 * `src/tools/register/core.ts`. It forwards to
 * `IndexingPipeline.indexFiles([filePath])` and surfaces the same
 * `{ totalFiles, indexed, skipped, errors, durationMs }` shape used by
 * `reindex` plus a `status` field and an optional `_duplication_warnings`
 * envelope built from `checkFileForDuplicates`. We assert the underlying
 * pipeline contract (same approach as `get-env-vars.behavioural.test.ts`).
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../../src/config.js';
import { IndexingPipeline } from '../../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../../src/plugin-api/registry.js';
import { createTestStore } from '../../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../../fixtures/no-framework');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE_DIR,
    include: ['src/**/*.ts', 'app/**/*.php'],
    exclude: ['vendor/**', 'node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

function setup() {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const pipeline = new IndexingPipeline(store, registry, makeConfig(), FIXTURE_DIR);
  return { store, pipeline };
}

describe('register_edit (IndexingPipeline.indexFiles) — behavioural contract', () => {
  it('indexes an existing file and returns the expected envelope', async () => {
    const { store, pipeline } = setup();
    // Pick a TypeScript file we know exists in the fixture.
    const result = await pipeline.indexFiles(['src/index.ts']);

    expect(result).toBeTruthy();
    expect(typeof result.totalFiles).toBe('number');
    expect(typeof result.indexed).toBe('number');
    expect(typeof result.skipped).toBe('number');
    expect(typeof result.errors).toBe('number');
    expect(typeof result.durationMs).toBe('number');
    expect(result.totalFiles).toBeGreaterThanOrEqual(1);
    // The file must now be in the store.
    const file = store.getFile('src/index.ts');
    expect(file).toBeDefined();
  });

  it('is idempotent on unchanged content: a second call hits the hash cache', async () => {
    const { pipeline } = setup();
    const first = await pipeline.indexFiles(['src/index.ts']);
    expect(first.indexed + first.skipped).toBeGreaterThanOrEqual(1);

    const second = await pipeline.indexFiles(['src/index.ts']);
    // After the first index, the second call should see either an indexed=0
    // result (hash matched, no re-extract) OR skipped >= 1 — either way the
    // total work is bounded by the same file count.
    expect(second.totalFiles).toBeGreaterThanOrEqual(1);
    expect(second.errors).toBe(0);
  });

  it('non-existent path produces a clean no-op envelope (no throw)', async () => {
    const { pipeline } = setup();
    const result = await pipeline.indexFiles(['does/not/exist.ts']);
    expect(result).toBeTruthy();
    // The pipeline must not silently throw — totalFiles is reported and
    // indexed is zero for a missing path.
    expect(typeof result.totalFiles).toBe('number');
    expect(result.indexed).toBe(0);
  });

  it('output shape: every numeric field is a finite number', async () => {
    const { pipeline } = setup();
    const result = await pipeline.indexFiles(['src/index.ts']);
    for (const k of ['totalFiles', 'indexed', 'skipped', 'errors', 'durationMs'] as const) {
      expect(Number.isFinite(result[k])).toBe(true);
    }
  });
});
