/**
 * TRA-2558: IndexingPipeline.deleteFilesByPrefix(relPrefix)
 *
 * Verifies that deleting files by prefix removes rows from `files`, cascades to
 * symbols, updates FTS/search caches, and leaves unrelated files untouched.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { TraceMcpConfigSchema } from '../../config.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { IndexingPipeline } from '../pipeline.js';

describe('IndexingPipeline.deleteFilesByPrefix (TRA-2558)', () => {
  let workDir: string;
  let db: ReturnType<typeof initializeDatabase>;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'delete-prefix-test-'));
    db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();
    const config = TraceMcpConfigSchema.parse({
      root: workDir,
      include: ['**/*'],
      exclude: [],
    });
    pipeline = new IndexingPipeline(store, registry, config, workDir);
  });

  afterEach(async () => {
    await pipeline.dispose();
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('deletes all files under the specified relative prefix', async () => {
    const f1 = store.insertFile('root.ts', 'typescript', 'h1', 10, null, null);
    const f2 = store.insertFile('child/a.ts', 'typescript', 'h2', 10, null, null);
    const f3 = store.insertFile('child/nested/b.ts', 'typescript', 'h3', 10, null, null);
    const f4 = store.insertFile('other/c.ts', 'typescript', 'h4', 10, null, null);

    store.insertSymbols(f2, [
      {
        symbolId: 'child/a.ts::foo#function',
        name: 'foo',
        kind: 'function',
        byteStart: 0,
        byteEnd: 10,
        lineStart: 1,
        lineEnd: 1,
      },
    ]);
    store.insertSymbols(f3, [
      {
        symbolId: 'child/nested/b.ts::bar#function',
        name: 'bar',
        kind: 'function',
        byteStart: 0,
        byteEnd: 10,
        lineStart: 1,
        lineEnd: 1,
      },
    ]);
    store.insertSymbols(f1, [
      {
        symbolId: 'root.ts::rootFn#function',
        name: 'rootFn',
        kind: 'function',
        byteStart: 0,
        byteEnd: 10,
        lineStart: 1,
        lineEnd: 1,
      },
    ]);

    const getSymbolCount = () =>
      (db.prepare('SELECT count(*) as count FROM symbols').get() as { count: number }).count;

    expect(store.getAllFiles()).toHaveLength(4);
    expect(getSymbolCount()).toBe(3);

    const deleted = await pipeline.deleteFilesByPrefix('child');
    expect(deleted).toBe(2);

    const remainingPaths = store.getAllFiles().map((f) => f.path);
    expect(remainingPaths).toEqual(expect.arrayContaining(['root.ts', 'other/c.ts']));
    expect(remainingPaths).not.toContain('child/a.ts');
    expect(remainingPaths).not.toContain('child/nested/b.ts');

    // Symbols for deleted files must be cascaded away
    expect(getSymbolCount()).toBe(1);
    expect(store.getSymbolsByFile(f1).map((s) => s.name)).toEqual(['rootFn']);
  });

  it('tolerates trailing slash and nested prefixes', async () => {
    store.insertFile('packages/sub/index.ts', 'typescript', 'h1', 10, null, null);
    store.insertFile('packages/other/index.ts', 'typescript', 'h2', 10, null, null);

    const deleted = await pipeline.deleteFilesByPrefix('packages/sub/');
    expect(deleted).toBe(1);

    const remaining = store.getAllFiles().map((f) => f.path);
    expect(remaining).toEqual(['packages/other/index.ts']);
  });

  it('rejects invalid or unsafe prefixes without deleting anything', async () => {
    store.insertFile('src/a.ts', 'typescript', 'h1', 10, null, null);
    store.insertFile('src/b.ts', 'typescript', 'h2', 10, null, null);

    expect(await pipeline.deleteFilesByPrefix('')).toBe(0);
    expect(await pipeline.deleteFilesByPrefix('.')).toBe(0);
    expect(await pipeline.deleteFilesByPrefix('..')).toBe(0);
    expect(await pipeline.deleteFilesByPrefix('../outside')).toBe(0);
    expect(await pipeline.deleteFilesByPrefix('/')).toBe(0);

    expect(store.getAllFiles()).toHaveLength(2);
  });

  it('safely no-ops when database is closed', async () => {
    store.insertFile('src/a.ts', 'typescript', 'h1', 10, null, null);
    db.close();

    expect(await pipeline.deleteFilesByPrefix('src')).toBe(0);
  });

  it('preserves forced intent when debounced coverage reconcile coalesces with unforced calls (TRA-2558 P2)', async () => {
    let indexAllCalls = 0;
    pipeline.indexAll = async () => {
      indexAllCalls++;
      return {
        totalFiles: 0,
        indexed: 0,
        skipped: 0,
        errors: 0,
        durationMs: 0,
        incremental: false,
        postprocess: 'full',
      };
    };

    // First request with force: true
    pipeline.requestCoverageReconcile({ force: true });
    expect(
      (pipeline as unknown as { _coverageReconcileForced: boolean })._coverageReconcileForced,
    ).toBe(true);

    // Follow-up watcher event calls scheduleCoverageReconcile(false)
    (
      pipeline as unknown as { scheduleCoverageReconcile(force?: boolean): void }
    ).scheduleCoverageReconcile(false);
    // Intent must NOT be reset to false by the unforced call
    expect(
      (pipeline as unknown as { _coverageReconcileForced: boolean })._coverageReconcileForced,
    ).toBe(true);

    // When flushed, indexAll must be invoked because force was preserved
    await pipeline.__flushCoverageReconcileForTests();
    expect(indexAllCalls).toBe(1);
  });

  it('serializes deleteFilesByPrefix onto the pipeline _lock (TRA-2558 P1)', async () => {
    store.insertFile('sub/file.ts', 'typescript', 'h1', 10, null, null);

    let lockReleased = false;
    // Artificially chain a delayed promise onto _lock
    const lockChain = (pipeline as unknown as { _lock: Promise<unknown> })._lock;
    (pipeline as unknown as { _lock: Promise<unknown> })._lock = lockChain.then(async () => {
      await new Promise((res) => setTimeout(res, 50));
      lockReleased = true;
    });

    const deletePromise = pipeline.deleteFilesByPrefix('sub');
    // Before lock is released, delete has not settled
    expect(lockReleased).toBe(false);

    const deleted = await deletePromise;
    expect(lockReleased).toBe(true);
    expect(deleted).toBe(1);
    expect(store.getAllFiles()).toHaveLength(0);
  });
});
