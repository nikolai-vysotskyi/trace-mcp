import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import type { FileRow } from '../../src/db/types.js';
import { collectFiles } from '../../src/indexer/file-collector.js';
import { detectRenames, type RenameDetectorStore } from '../../src/indexer/rename-detector.js';
import { hashContent } from '../../src/utils/hasher.js';
import { initContentHasher } from '../../src/util/hash.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('TRA-2380: event loop stall prevention during reindexing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    await initContentHasher();
    tmpDir = createTmpDir('tra-2380-');
  });

  afterEach(() => {
    removeTmpDir(tmpDir);
  });

  describe('detectRenames (TRA-2380)', () => {
    it('does not stat non-matching DB files when adding a new file', () => {
      // Setup a new file on disk
      const newFilePath = 'src/brand-new.ts';
      const absNew = path.join(tmpDir, newFilePath);
      fs.mkdirSync(path.dirname(absNew), { recursive: true });
      fs.writeFileSync(absNew, 'export const brandNew = 123;');

      const existsSyncSpy = vi.spyOn(fs, 'existsSync');

      // Store with 1000 simulated files whose hashes do NOT match the new file
      const dummyRows: FileRow[] = Array.from({ length: 1000 }, (_, i) => ({
        id: i + 1,
        path: `src/old-file-${i}.ts`,
        language: 'typescript',
        status: 'ok',
        byte_length: 50,
        indexed_at: 'now',
        content_hash: `dummy_hash_${i}`,
        mtime_ms: 1000 + i,
      }));

      const store: RenameDetectorStore = {
        getAllFiles: vi.fn(() => dummyRows),
        updateFilePath: vi.fn(),
      };

      const existingFiles = new Map<string, FileRow>();
      // Run detectRenames for the brand new file
      const result = detectRenames(store, tmpDir, [newFilePath], existingFiles);

      expect(result).toEqual({ renamed: 0, pairs: [] });
      // Crucial assertion: fs.existsSync must NOT have been called 1000 times on dummy files!
      // In TRA-2380, each dummy file was checked with fs.existsSync, blocking event loop for seconds.
      expect(existsSyncSpy).not.toHaveBeenCalled();

      existsSyncSpy.mockRestore();
    });

    it('correctly detects rename and only checks existence for candidate with matching hash', () => {
      const content = Buffer.from('export const sharedContent = 999;');
      const contentHash = hashContent(content);

      // New file on disk
      const newRel = 'src/renamed.ts';
      const newAbs = path.join(tmpDir, newRel);
      fs.mkdirSync(path.dirname(newAbs), { recursive: true });
      fs.writeFileSync(newAbs, content);

      // Old file path does NOT exist on disk
      const oldRel = 'src/original.ts';

      const existsSyncSpy = vi.spyOn(fs, 'existsSync');

      const matchingRow: FileRow = {
        id: 42,
        path: oldRel,
        language: 'typescript',
        status: 'ok',
        byte_length: content.length,
        indexed_at: 'now',
        content_hash: contentHash,
        mtime_ms: 5000,
      };

      const nonMatchingRows: FileRow[] = Array.from({ length: 500 }, (_, i) => ({
        id: i + 100,
        path: `src/unrelated-${i}.ts`,
        language: 'typescript',
        status: 'ok',
        byte_length: 10,
        indexed_at: 'now',
        content_hash: `unrelated_${i}`,
        mtime_ms: 1000,
      }));

      const store: RenameDetectorStore = {
        getAllFiles: vi.fn(() => [matchingRow, ...nonMatchingRows]),
        updateFilePath: vi.fn(),
      };

      const existingFiles = new Map<string, FileRow>();
      const result = detectRenames(store, tmpDir, [newRel], existingFiles);

      expect(result.renamed).toBe(1);
      expect(result.pairs).toEqual([{ from: oldRel, to: newRel }]);
      expect(store.updateFilePath).toHaveBeenCalledWith(42, newRel);

      // fs.existsSync should ONLY have been checked for the matching candidate (oldRel), not 500 unrelated files
      expect(existsSyncSpy).toHaveBeenCalledTimes(1);
      expect(existsSyncSpy).toHaveBeenCalledWith(path.resolve(tmpDir, oldRel));

      existsSyncSpy.mockRestore();
    });
  });

  describe('collectFiles deep traversal boundedness (TRA-2380)', () => {
    it('bounds fallback deep glob search to maxFiles and deep: 5', async () => {
      // Create subproject structure deeper than root
      const subprojectSrc = path.join(tmpDir, 'nested', 'pkg', 'src');
      fs.mkdirSync(subprojectSrc, { recursive: true });
      for (let i = 0; i < 20; i++) {
        fs.writeFileSync(path.join(subprojectSrc, `file${i}.ts`), `export const v${i} = ${i};`);
      }

      // Rooted pattern that finds nothing at rootPath
      const config = TraceMcpConfigSchema.parse({
        include: ['src/**/*.ts'],
        exclude: [],
      });

      // Collect with maxFiles = 5
      const result = await collectFiles({
        config,
        rootPath: tmpDir,
        workspaces: [],
        traceignore: undefined,
        maxFiles: 5,
      });

      expect(result.truncated).toBe(true);
      expect(result.files).toHaveLength(5);
      expect(result.limit).toBe(5);
      expect(result.found).toBeGreaterThanOrEqual(5);
    });
  });
});
