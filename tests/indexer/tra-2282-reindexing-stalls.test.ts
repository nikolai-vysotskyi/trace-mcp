import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRow } from '../../src/db/types.js';
import {
  clearPackageEntriesCache,
  findPackageJsonEntries,
} from '../../src/indexer/package-entries.js';
import { detectRenames, type RenameDetectorStore } from '../../src/indexer/rename-detector.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('TRA-2282: reindexing stall fixes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir('tra-2282-');
    clearPackageEntriesCache();
  });

  afterEach(() => {
    clearPackageEntriesCache();
    removeTmpDir(tmpDir);
  });

  it('detectRenames short-circuits without scanning store when all paths exist in existingFiles', () => {
    const store: RenameDetectorStore = {
      getAllFiles: vi.fn(() => []),
      updateFilePath: vi.fn(),
    };

    const existingFiles = new Map<string, FileRow>([
      [
        'src/index.ts',
        {
          id: 1,
          path: 'src/index.ts',
          language: 'typescript',
          status: 'ok',
          byte_length: 100,
          indexed_at: 'now',
          content_hash: 'hash1',
          mtime_ms: 1000,
        },
      ],
      [
        'src/utils.ts',
        {
          id: 2,
          path: 'src/utils.ts',
          language: 'typescript',
          status: 'ok',
          byte_length: 200,
          indexed_at: 'now',
          content_hash: 'hash2',
          mtime_ms: 2000,
        },
      ],
    ]);

    // Incremental batch where only known existing files were edited
    const result = detectRenames(store, tmpDir, ['src/index.ts', 'src/utils.ts'], existingFiles);

    expect(result).toEqual({ renamed: 0, pairs: [] });
    // Must NOT query getAllFiles or call fs.existsSync on every file in DB
    expect(store.getAllFiles).not.toHaveBeenCalled();
  });

  it('findPackageJsonEntries caches results per root to avoid repeated filesystem walks', () => {
    const pkgPath = path.join(tmpDir, 'package.json');
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: 'test-pkg',
        main: './lib/index.js',
      }),
    );

    const readdirSpy = vi.spyOn(fs, 'readdirSync');

    // First call walks filesystem
    const first = findPackageJsonEntries(tmpDir);
    expect(first).toContain('lib/index.js');
    const firstCalls = readdirSpy.mock.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    // Second call hits cache without calling readdirSync again
    const second = findPackageJsonEntries(tmpDir);
    expect(second).toEqual(first);
    expect(readdirSpy.mock.calls.length).toBe(firstCalls);

    readdirSpy.mockRestore();
  });

  it('clearPackageEntriesCache invalidates cache when package.json is updated', () => {
    const pkgPath = path.join(tmpDir, 'package.json');
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: 'test-pkg',
        main: './lib/index.js',
      }),
    );

    const first = findPackageJsonEntries(tmpDir);
    expect(first).toContain('lib/index.js');
    expect(first).not.toContain('lib/new-index.js');

    // Update package.json to point to new entry
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: 'test-pkg',
        main: './lib/new-index.js',
      }),
    );

    // Without clearing cache, old entry remains
    const cached = findPackageJsonEntries(tmpDir);
    expect(cached).toContain('lib/index.js');

    // Invalidate cache
    clearPackageEntriesCache(tmpDir);

    // New entry point is picked up immediately
    const updated = findPackageJsonEntries(tmpDir);
    expect(updated).toContain('lib/new-index.js');
    expect(updated).not.toContain('lib/index.js');
  });

  it('packageEntriesCache maintains true LRU order on access', () => {
    // MAX_PACKAGE_ENTRIES_CACHE_ENTRIES is 20
    const dirs: string[] = [];
    for (let i = 0; i < 21; i++) {
      const dir = path.join(tmpDir, `sub-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: `pkg-${i}`, main: `./index-${i}.js` }),
      );
      dirs.push(dir);
    }

    // Populate cache with dirs 0..19 (20 entries)
    for (let i = 0; i < 20; i++) {
      findPackageJsonEntries(dirs[i]!);
    }

    // Access dir 0 again — moves dir 0 to MRU!
    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    findPackageJsonEntries(dirs[0]!);
    expect(readdirSpy).not.toHaveBeenCalled(); // cache hit

    // Now insert dir 20 — capacity (20) exceeded, so the LRU entry (dir 1) should be evicted
    findPackageJsonEntries(dirs[20]!);

    // dir 0 should still be cached (cache hit, no readdir)
    readdirSpy.mockClear();
    findPackageJsonEntries(dirs[0]!);
    expect(readdirSpy).not.toHaveBeenCalled();

    // dir 1 was LRU and should have been evicted (re-walks filesystem)
    readdirSpy.mockClear();
    findPackageJsonEntries(dirs[1]!);
    expect(readdirSpy).toHaveBeenCalled();

    readdirSpy.mockRestore();
  });

  it('IndexingPipeline deleteFiles invalidates packageEntriesCache when package.json is deleted', async () => {
    const { initializeDatabase } = await import('../../src/db/schema.js');
    const { Store } = await import('../../src/db/store.js');
    const { IndexingPipeline } = await import('../../src/indexer/pipeline.js');
    const { PluginRegistry } = await import('../../src/plugin-api/registry.js');

    const pkgPath = path.join(tmpDir, 'package.json');
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({
        name: 'test-pkg',
        main: './lib/index.js',
      }),
    );

    // Cache the entries
    findPackageJsonEntries(tmpDir);

    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const registry = new PluginRegistry();
    const pipeline = new IndexingPipeline(
      store,
      registry,
      { root: tmpDir, include: ['**/*'], exclude: [], plugins: [] },
      tmpDir,
    );

    const readdirSpy = vi.spyOn(fs, 'readdirSync');

    // Deleting unrelated file should NOT invalidate packageEntriesCache
    pipeline.deleteFiles(['src/some-file.ts']);
    findPackageJsonEntries(tmpDir);
    expect(readdirSpy).not.toHaveBeenCalled();

    // Deleting package.json should invalidate packageEntriesCache
    pipeline.deleteFiles(['package.json']);
    findPackageJsonEntries(tmpDir);
    expect(readdirSpy).toHaveBeenCalled();

    readdirSpy.mockRestore();
    db.close();
  });

  it('IndexingPipeline maybeAnalyze skips isStatDivergent queries on routine incremental saves', async () => {
    const { initializeDatabase } = await import('../../src/db/schema.js');
    const { Store } = await import('../../src/db/store.js');
    const { IndexingPipeline, META_LAST_ANALYZE_MS } = await import(
      '../../src/indexer/pipeline.js'
    );
    const { PluginRegistry } = await import('../../src/plugin-api/registry.js');

    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    const registry = new PluginRegistry();
    const pipeline = new IndexingPipeline(
      store,
      registry,
      { root: tmpDir, include: ['**/*'], exclude: [], plugins: [] },
      tmpDir,
    );

    // Stamp recent analyze time so we are within the throttle window
    store.setRepoMetadata(META_LAST_ANALYZE_MS, String(Date.now()));

    // Spy on db.prepare to observe queries executed
    const prepareSpy = vi.spyOn(db, 'prepare');

    // Private method access to test maybeAnalyze directly
    const pipelineAny = pipeline as unknown as {
      _filesIndexedSinceAnalyze: number;
      maybeAnalyze: (force?: boolean) => void;
    };

    // Incremental save with only 1 file indexed (< 50)
    pipelineAny._filesIndexedSinceAnalyze = 1;
    pipelineAny.maybeAnalyze();

    // Should NOT have run any sqlite_stat1 query or count(*) on files table!
    const divergenceQueries = prepareSpy.mock.calls.filter((call) => {
      const sql = typeof call[0] === 'string' ? call[0] : '';
      return sql.includes('sqlite_stat1') || sql.includes('count(*) as c FROM files');
    });
    expect(divergenceQueries).toHaveLength(0);

    // When 50 files indexed, divergence check should now run
    pipelineAny._filesIndexedSinceAnalyze = 50;
    prepareSpy.mockClear();
    pipelineAny.maybeAnalyze();

    const checkedDivergenceQueries = prepareSpy.mock.calls.filter((call) => {
      const sql = typeof call[0] === 'string' ? call[0] : '';
      return sql.includes('sqlite_stat1') || sql.includes('sqlite_master');
    });
    expect(checkedDivergenceQueries.length).toBeGreaterThan(0);

    prepareSpy.mockRestore();
    db.close();
  });
});
