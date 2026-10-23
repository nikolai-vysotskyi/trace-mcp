/**
 * TRA-2557: Tests for bidirectional coverage reconcile on file deletions.
 *
 * Background: when files are deleted on disk in bulk (or FSEvents delete events
 * are dropped), onDisk < indexed, resulting in gap = onDisk - indexed < 0.
 * The pipeline must check |gap| >= COVERAGE_DRIFT_MIN_FILES (10), ignore synthetic
 * files (__external__/*), schedule reconcile on deleteFiles(), and converge via
 * __flushCoverageReconcileForTests().
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { IndexingPipeline } from '../pipeline.js';
import { TypeScriptLanguagePlugin } from '../plugins/language/typescript/index.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { createTestStore } from '../../../tests/test-utils.js';

const DEBOUNCE_MS = 10 * 60_000;

function makeSetup(rootDir: string, include = ['src/**/*.ts']) {
  const store = createTestStore();
  const registry = new PluginRegistry();
  registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());

  const config = TraceMcpConfigSchema.parse({
    root: rootDir,
    include,
    exclude: [],
  });

  const pipeline = new IndexingPipeline(store, registry, config, rootDir, undefined, {
    coverageReconcileDebounceMs: DEBOUNCE_MS,
  });
  return { store, pipeline };
}

describe('coverage reconcile on deletions (TRA-2557)', () => {
  let rootDir: string;
  let store: ReturnType<typeof createTestStore>;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-cov-del-'));
    fs.mkdirSync(path.join(rootDir, 'src'));
    ({ store, pipeline } = makeSetup(rootDir));
  });

  afterEach(async () => {
    await pipeline.dispose();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('converges index when >= 10 files are deleted from disk and dropped from watcher', async () => {
    // 1. Create 20 files on disk and index them
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(
        path.join(rootDir, 'src', `file${i}.ts`),
        `export function fn${i}() { return ${i}; }\n`,
      );
    }
    await pipeline.indexAll();
    expect(store.getStats().totalFiles).toBe(20);

    // 2. Insert a synthetic file (__external__/*) — it must be ignored in gap calculation
    store.insertFile('__external__/_root/typescript.synthetic', 'typescript', '__phantom__', 0);
    expect(store.getStats().totalFiles).toBe(21);

    // 3. Delete 15 files from disk (file5.ts through file19.ts)
    for (let i = 5; i < 20; i++) {
      fs.unlinkSync(path.join(rootDir, 'src', `file${i}.ts`));
    }

    // 4. deleteFiles() called for just 1 file (e.g. file5.ts reported by watcher)
    // This removes file5.ts from the DB and schedules coverage reconcile!
    pipeline.deleteFiles(['src/file5.ts']);

    // At this point, files 6..19 are ghost files: deleted from disk but still in the DB
    expect(store.getFile('src/file6.ts')).toBeDefined();
    expect(store.getFile('src/file19.ts')).toBeDefined();

    // 5. Flush coverage reconcile
    await pipeline.__flushCoverageReconcileForTests();

    // 6. Verify ghost files were purged and index converged
    // Remaining real files: file0..file4 (5 files) + 1 synthetic file
    expect(store.getFile('src/file6.ts')).toBeUndefined();
    expect(store.getFile('src/file19.ts')).toBeUndefined();
    expect(store.getFile('src/file0.ts')).toBeDefined();
    expect(store.getFile('src/file4.ts')).toBeDefined();
    expect(store.getFile('__external__/_root/typescript.synthetic')).toBeDefined();

    // Total files: 5 real on disk + 1 synthetic = 6
    expect(store.getStats().totalFiles).toBe(6);
  });

  it('does not reindex when deletion gap is below threshold (< 10 files)', async () => {
    // Create 12 files on disk and index them
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(rootDir, 'src', `file${i}.ts`),
        `export function fn${i}() { return ${i}; }\n`,
      );
    }
    await pipeline.indexAll();
    expect(store.getStats().totalFiles).toBe(12);

    // Delete only 3 files from disk (gap = 3 < 10)
    fs.unlinkSync(path.join(rootDir, 'src', 'file0.ts'));
    fs.unlinkSync(path.join(rootDir, 'src', 'file1.ts'));
    fs.unlinkSync(path.join(rootDir, 'src', 'file2.ts'));

    // Report deletion of file0.ts to arm the coverage reconcile timer
    pipeline.deleteFiles(['src/file0.ts']);
    expect(store.getStats().totalFiles).toBe(11);

    const indexAllSpy = vi.spyOn(pipeline, 'indexAll');
    await pipeline.__flushCoverageReconcileForTests();

    // Reindex should not have run because |gap| = |9 - 11| = 2 < 10
    expect(indexAllSpy).not.toHaveBeenCalled();
    indexAllSpy.mockRestore();
  });

  it('counts normal files matching wildcard shape like XXexternalYY/foo.ts in coverage drift', async () => {
    // Regression test for TRA-2557: LIKE '__external__/%' treated '_' as single-character wildcard,
    // which would exclude 'XXexternalYY/foo.ts' from indexed count. With GLOB, it is correctly counted.
    const { store: customStore, pipeline: customPipeline } = makeSetup(rootDir, ['**/*.ts']);
    try {
      fs.mkdirSync(path.join(rootDir, 'XXexternalYY'), { recursive: true });
      fs.writeFileSync(
        path.join(rootDir, 'XXexternalYY', 'foo.ts'),
        'export function foo() { return "foo"; }\n',
      );
      for (let i = 0; i < 14; i++) {
        fs.writeFileSync(
          path.join(rootDir, `file${i}.ts`),
          `export function fn${i}() { return ${i}; }\n`,
        );
      }
      await customPipeline.indexAll();
      expect(customStore.getStats().totalFiles).toBe(15);

      // Verify that XXexternalYY/foo.ts is counted in the coverage drift query
      const row = customStore.db
        .prepare(
          "SELECT COUNT(*) as c FROM files WHERE path NOT GLOB '__external__/*' AND path != '__external__'",
        )
        .get() as { c: number };
      expect(row.c).toBe(15);

      // Delete 11 files from disk (file0..file9 + XXexternalYY/foo.ts)
      for (let i = 0; i < 10; i++) {
        fs.unlinkSync(path.join(rootDir, `file${i}.ts`));
      }
      fs.unlinkSync(path.join(rootDir, 'XXexternalYY', 'foo.ts'));

      // Delete file0 in pipeline to schedule coverage reconcile
      customPipeline.deleteFiles(['file0.ts']);

      // onDisk = 4 (file10..file13)
      // indexed in DB = 14 (file0 removed, but XXexternalYY/foo.ts is still in DB as a ghost)
      // gap = 4 - 14 = -10, |gap| >= 10, so reconcile should run and purge ghosts!
      await customPipeline.__flushCoverageReconcileForTests();

      expect(customStore.getStats().totalFiles).toBe(4);
      expect(customStore.getFile('XXexternalYY/foo.ts')).toBeUndefined();
    } finally {
      await customPipeline.dispose();
    }
  });
});
