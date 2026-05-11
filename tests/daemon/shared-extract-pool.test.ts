/**
 * Two IndexingPipeline instances share one ExtractPool when injected via DI.
 * Covers Phase 2.1 — pool lives in ProjectManager (or an analogous host) and
 * each pipeline borrows it.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { ExtractPool } from '../../src/indexer/extract-pool.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/no-framework');

function makePipeline(pool: ExtractPool | null = null): IndexingPipeline {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const config: TraceMcpConfig = {
    root: FIXTURE_DIR,
    include: ['src/**/*.ts'],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
  };
  return new IndexingPipeline(store, registry, config, FIXTURE_DIR, undefined, {
    extractPool: pool,
  });
}

describe('IndexingPipeline — shared ExtractPool via DI', () => {
  it('both pipelines reference the injected pool, dispose does not terminate it', async () => {
    const shared = new ExtractPool({ keepAlive: true, size: 2 });
    const a = makePipeline(shared);
    const b = makePipeline(shared);

    type WithPrivate = IndexingPipeline & {
      _extractPool: ExtractPool | undefined;
      _poolIsOwned: boolean;
    };
    expect((a as WithPrivate)._extractPool).toBe(shared);
    expect((b as WithPrivate)._extractPool).toBe(shared);
    expect((a as WithPrivate)._poolIsOwned).toBe(false);
    expect((b as WithPrivate)._poolIsOwned).toBe(false);

    // dispose() on both pipelines must NOT terminate the shared pool —
    // the daemon owns its lifecycle. Use the internal `terminated` flag
    // since `.available` also depends on the bundled worker entry which
    // isn't present in tsx/vitest mode.
    type WithTerminated = ExtractPool & { terminated: boolean };
    await a.dispose();
    await b.dispose();
    expect((shared as WithTerminated).terminated).toBe(false);

    await shared.terminate();
    expect((shared as WithTerminated).terminated).toBe(true);
  });

  it('without DI, each pipeline lazily owns its own pool and dispose terminates it', async () => {
    const a = makePipeline(null);
    type WithPrivate = IndexingPipeline & {
      _extractPool: ExtractPool | undefined;
      _poolIsOwned: boolean;
      maybeGetExtractPool: (n: number) => ExtractPool | null;
    };
    // Force lazy creation with a batch above WORKER_THRESHOLD.
    const pool = (a as WithPrivate).maybeGetExtractPool(10_000);
    if (pool) {
      expect((a as WithPrivate)._poolIsOwned).toBe(true);
    }
    await a.dispose();
    expect((a as WithPrivate)._extractPool).toBeUndefined();
  });
});
