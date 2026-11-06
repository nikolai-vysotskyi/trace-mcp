import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { IndexingPipeline, readIndexTruncation } from '../pipeline.js';
import { collectFiles } from '../file-collector.js';

describe('TRA-2941: limit boundary precision, repeat reconcile stability, and scope retention under truncation', () => {
  let workDir: string;
  let db: Database.Database;
  let store: Store;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'truncation-boundary-2941-'));
    mkdirSync(join(workDir, 'src', 'pkg_b'), { recursive: true });
    mkdirSync(join(workDir, 'src', 'pkg_a'), { recursive: true });
    db = initializeDatabase(join(workDir, 'index.db'));
    store = new Store(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  function makePipeline(maxFiles: number): IndexingPipeline {
    return new IndexingPipeline(
      store,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({
        root: workDir,
        include: ['src/**/*.ts'],
        exclude: [],
        security: { max_files: maxFiles },
      }),
      workDir,
    );
  }

  it('exact boundary: found === maxFiles is NOT truncated and does not stamp metadata', async () => {
    // Exactly 5 files with max_files = 5
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(workDir, 'src', 'pkg_b', `file_${i}.ts`), `export const v${i} = ${i};\n`);
    }

    const config = TraceMcpConfigSchema.parse({
      root: workDir,
      include: ['src/**/*.ts'],
      exclude: [],
      security: { max_files: 5 },
    });

    const collected = await collectFiles({
      config,
      rootPath: workDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 5,
    });

    expect(collected.truncated).toBe(false);
    expect(collected.found).toBe(5);
    expect(collected.limit).toBe(5);
    expect(collected.files).toHaveLength(5);

    const pipeline = makePipeline(5);
    try {
      const res = await pipeline.indexAll();
      expect(res.truncated).toBeUndefined();
      expect(store.getStats().totalFiles).toBe(5);
      expect(readIndexTruncation(store)).toBeNull();
    } finally {
      await pipeline.dispose();
    }
  });

  it('boundary + 1: found === maxFiles + 1 is truncated, sorts deterministically, and stamps metadata', async () => {
    // 6 files with max_files = 5
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(workDir, 'src', 'pkg_b', `file_${i}.ts`), `export const v${i} = ${i};\n`);
    }

    const config = TraceMcpConfigSchema.parse({
      root: workDir,
      include: ['src/**/*.ts'],
      exclude: [],
      security: { max_files: 5 },
    });

    const collected = await collectFiles({
      config,
      rootPath: workDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 5,
    });

    expect(collected.truncated).toBe(true);
    expect(collected.found).toBe(6);
    expect(collected.limit).toBe(5);
    // Deterministically alphabetically sorted: file_0 .. file_4, file_5 omitted
    expect(collected.files).toEqual([
      'src/pkg_b/file_0.ts',
      'src/pkg_b/file_1.ts',
      'src/pkg_b/file_2.ts',
      'src/pkg_b/file_3.ts',
      'src/pkg_b/file_4.ts',
    ]);

    const pipeline = makePipeline(5);
    try {
      const res = await pipeline.indexAll();
      expect(res.truncated).toEqual({ found: 6, limit: 5 });
      expect(store.getStats().totalFiles).toBe(5);
      expect(readIndexTruncation(store)).toEqual({ found: 6, limit: 5 });
    } finally {
      await pipeline.dispose();
    }
  });

  it('repeated reconcile on unchanged truncated root produces identical file set with zero thrash', async () => {
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(workDir, 'src', 'pkg_b', `file_${i}.ts`), `export const v${i} = ${i};\n`);
    }

    const pipeline = makePipeline(5);
    try {
      // 1. Initial index
      const run1 = await pipeline.indexAll();
      expect(run1.truncated).toEqual({ found: 6, limit: 5 });
      expect(store.getStats().totalFiles).toBe(5);

      // 2. Repeat reconcile pass (discovery: 'full-walk', non-force)
      const run2 = await pipeline.indexAll(false, { discovery: 'full-walk' });
      expect(run2.truncated).toEqual({ found: 6, limit: 5 });
      expect(run2.indexed).toBe(0); // All 5 files were unchanged, skipped re-extract
      expect(run2.skipped).toBe(5);
      expect(store.getStats().totalFiles).toBe(5);
      expect(readIndexTruncation(store)).toEqual({ found: 6, limit: 5 });
    } finally {
      await pipeline.dispose();
    }
  });

  it('deleting a file brings count back to boundary, admits previously omitted file, and clears truncation stamp', async () => {
    // 6 files: file_0 .. file_5, max_files = 5
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(workDir, 'src', 'pkg_b', `file_${i}.ts`), `export const v${i} = ${i};\n`);
    }

    const pipeline = makePipeline(5);
    try {
      await pipeline.indexAll();
      expect(readIndexTruncation(store)).toEqual({ found: 6, limit: 5 });

      // Delete file_0 (which was indexed)
      unlinkSync(join(workDir, 'src', 'pkg_b', 'file_0.ts'));

      // Reconcile pass: now 5 files remain on disk (file_1 .. file_5)
      const rec = await pipeline.indexAll(false, { discovery: 'full-walk' });
      expect(rec.truncated).toBeUndefined();
      expect(readIndexTruncation(store)).toBeNull();

      // file_0 pruned, file_5 admitted
      const allFiles = store
        .getAllFiles()
        .map((f) => f.path)
        .sort();
      expect(allFiles).toEqual([
        'src/pkg_b/file_1.ts',
        'src/pkg_b/file_2.ts',
        'src/pkg_b/file_3.ts',
        'src/pkg_b/file_4.ts',
        'src/pkg_b/file_5.ts',
      ]);
      expect(store.getStats().totalFiles).toBe(5);
    } finally {
      await pipeline.dispose();
    }
  });

  it('scope retention: adding an earlier file preserves previously indexed row that fell past cap', async () => {
    // 5 files in pkg_b: file_0 .. file_4, max_files = 5
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(workDir, 'src', 'pkg_b', `file_${i}.ts`), `export const v${i} = ${i};\n`);
    }

    const pipeline = makePipeline(5);
    try {
      await pipeline.indexAll();
      // Indexed files: pkg_b/file_0 .. pkg_b/file_4
      expect(store.getStats().totalFiles).toBe(5);
      expect(readIndexTruncation(store)).toBeNull();

      // Add pkg_a/file_early.ts (pkg_a sorts before pkg_b alphabetically)
      writeFileSync(join(workDir, 'src', 'pkg_a', 'file_early.ts'), 'export const early = 1;\n');

      // Full reconcile walk: now 6 files found, capped at 5
      const rec = await pipeline.indexAll(false, { discovery: 'full-walk' });
      expect(rec.truncated).toEqual({ found: 6, limit: 5 });

      // In-scope top 5 is [pkg_a/file_early, pkg_b/file_0, pkg_b/file_1, pkg_b/file_2, pkg_b/file_3].
      // pkg_b/file_4 fell out of inScope, but still exists on disk.
      // selectOutOfScopeFiles retains pkg_b/file_4 because truncated=true and fileExists=true.
      const dbPaths = store
        .getAllFiles()
        .map((f) => f.path)
        .sort();
      expect(dbPaths).toContain('src/pkg_a/file_early.ts');
      expect(dbPaths).toContain('src/pkg_b/file_4.ts');
      // DB contains 6 files: 5 in-scope + 1 retained
      expect(store.getStats().totalFiles).toBe(6);
      expect(readIndexTruncation(store)).toEqual({ found: 6, limit: 5 });
    } finally {
      await pipeline.dispose();
    }
  });
});
