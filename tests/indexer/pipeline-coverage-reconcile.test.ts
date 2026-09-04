/**
 * Tests for the deferred coverage-reconcile pass (TRA-231).
 *
 * Background: a project registered before its real code lands on disk (fresh
 * workdir → `git clone` into a subdirectory) only ever gets the watcher's
 * incremental `indexFiles()` events afterwards. When a burst of thousands of
 * creates overflows the watcher, the index silently settles at a fraction of
 * the tree and only an explicit `reindex({force:true})` recovers it.
 *
 * The pipeline now schedules ONE debounced coverage check after incremental
 * churn: walk the include globs, compare the candidate count against the
 * indexed file count, and run a hash-gated `indexAll()` when the gap is real.
 *
 * Determinism: the debounce is injected ABSURDLY large so it never fires on
 * its own; tests trigger it explicitly via __flushCoverageReconcileForTests().
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

/** Never fires by itself — tests flush explicitly. */
const DEBOUNCE_MS = 10 * 60_000;

function makeSetup(rootDir: string) {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

  const config: TraceMcpConfig = {
    root: rootDir,
    include: ['src/**/*.ts'],
    exclude: [],
    plugins: [],
  };

  const pipeline = new IndexingPipeline(store, registry, config, rootDir, undefined, {
    coverageReconcileDebounceMs: DEBOUNCE_MS,
  });
  return { store, pipeline };
}

/** Write `n` source files the pipeline is never told about (dropped events). */
function writeUnannounced(rootDir: string, n: number): void {
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(
      path.join(rootDir, 'src', `dropped${i}.ts`),
      `export function dropped${i}() { return ${i}; }\n`,
    );
  }
}

describe('deferred coverage reconcile', () => {
  let rootDir: string;
  let store: ReturnType<typeof createTestStore>;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-coverage-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    fs.writeFileSync(path.join(rootDir, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
    ({ store, pipeline } = makeSetup(rootDir));
  });

  afterEach(async () => {
    await pipeline.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('recovers files the incremental path never saw', async () => {
    await pipeline.indexAll();
    expect(store.getStats().totalFiles).toBe(1);

    // A burst lands on disk; the watcher only reports one of the new files.
    writeUnannounced(rootDir, 30);
    fs.writeFileSync(
      path.join(rootDir, 'src', 'seen.ts'),
      'export function seen() { return 0; }\n',
    );
    await pipeline.indexFiles(['src/seen.ts']);
    expect(store.getStats().totalFiles).toBe(2);

    await pipeline.__flushCoverageReconcileForTests();

    // 1 original + 1 announced + 30 dropped
    expect(store.getStats().totalFiles).toBe(32);
  });

  it('does not reindex when on-disk and indexed counts agree', async () => {
    await pipeline.indexAll();

    fs.writeFileSync(path.join(rootDir, 'src', 'b.ts'), 'export function beta() { return 2; }\n');
    await pipeline.indexFiles(['src/b.ts']);

    const indexAllSpy = vi.spyOn(pipeline, 'indexAll');
    await pipeline.__flushCoverageReconcileForTests();
    expect(indexAllSpy).not.toHaveBeenCalled();
    indexAllSpy.mockRestore();
  });

  it('dispose() drops a pending reconcile', async () => {
    await pipeline.indexAll();
    writeUnannounced(rootDir, 30);
    fs.writeFileSync(
      path.join(rootDir, 'src', 'seen.ts'),
      'export function seen() { return 0; }\n',
    );
    await pipeline.indexFiles(['src/seen.ts']);

    await pipeline.dispose();
    await pipeline.__flushCoverageReconcileForTests();
    expect(store.getStats().totalFiles).toBe(2);
  });
});
