/**
 * Tests that IndexingPipeline serializes concurrent indexAll/indexFiles calls.
 *
 * The race condition being guarded: pipeline.indexAll() fires in the background
 * (in `serve`), and the file watcher immediately fires indexFiles() for a changed
 * file. Without the lock, indexAll() would later overwrite that file with stale
 * content because it collected the file list before the change was applied.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/no-framework');

function makeSetup() {
  const store = createTestStore();
  const db = store.db;
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

  const config: TraceMcpConfig = {
    root: FIXTURE_DIR,
    include: ['src/**/*.ts'],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
  };

  const pipeline = new IndexingPipeline(store, registry, config, FIXTURE_DIR);
  return { db, store, pipeline };
}

describe('IndexingPipeline serialization lock', () => {
  it('second call waits for first to finish (no interleaving)', async () => {
    const { pipeline } = makeSetup();

    const order: string[] = [];

    // Monkey-patch runPipeline indirectly: intercept at public API level
    // Both calls should complete without throwing and produce valid results
    const [r1, r2] = await Promise.all([
      pipeline.indexAll().then((r) => {
        order.push('indexAll');
        return r;
      }),
      pipeline.indexFiles(['src/utils.ts']).then((r) => {
        order.push('indexFiles');
        return r;
      }),
    ]);

    // Both completed
    expect(r1.errors).toBe(0);
    expect(r2.errors).toBe(0);

    // indexAll must have fully completed before indexFiles ran
    expect(order[0]).toBe('indexAll');
    expect(order[1]).toBe('indexFiles');
  });

  it('concurrent indexAll calls do not throw', async () => {
    const { pipeline } = makeSetup();

    const [r1, r2] = await Promise.all([pipeline.indexAll(), pipeline.indexAll()]);

    expect(r1.errors).toBe(0);
    expect(r2.errors).toBe(0);
  });

  it('second indexAll after error still runs', async () => {
    const { pipeline, store } = makeSetup();

    // Force the first indexAll to produce errors by closing DB mid-way — instead
    // just confirm that a second call always resolves even if the first one threw.
    // We simulate an error by patching collectFiles.
    const originalCollect = (pipeline as any).collectFiles.bind(pipeline);
    let callCount = 0;
    (pipeline as any).collectFiles = async () => {
      callCount++;
      if (callCount === 1) throw new Error('simulated failure');
      return originalCollect();
    };

    const p1 = pipeline.indexAll().catch(() => 'failed');
    const p2 = pipeline.indexAll();

    const [res1, res2] = await Promise.all([p1, p2]);

    expect(res1).toBe('failed');
    expect(res2.errors).toBe(0);
    expect(res2.indexed).toBeGreaterThan(0);
  });
});

describe('IndexingPipeline buildProjectContext caching', () => {
  it('returns the same context object on repeated calls (object identity)', async () => {
    const { pipeline } = makeSetup();

    // Access the private method directly to verify caching
    const p = pipeline as unknown as {
      buildProjectContext: () => object;
      _projectContext: object | undefined;
    };

    // Before any call, cache is empty
    expect(p._projectContext).toBeUndefined();

    const ctx1 = p.buildProjectContext();
    const ctx2 = p.buildProjectContext();

    // Same object reference — not re-read from disk
    expect(ctx1).toBe(ctx2);
    expect(p._projectContext).toBeDefined();
  });

  it('cache is populated after indexAll', async () => {
    const { pipeline } = makeSetup();

    const p = pipeline as unknown as { _projectContext: object | undefined };
    expect(p._projectContext).toBeUndefined();

    await pipeline.indexAll();

    expect(p._projectContext).toBeDefined();
  });
});
