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
});
