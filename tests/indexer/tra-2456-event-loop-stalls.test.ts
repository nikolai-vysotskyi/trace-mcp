import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPackageEntriesCache,
  findPackageJsonEntries,
  findPackageJsonEntriesAsync,
  PACKAGE_SCAN_SKIP_DIRS,
  readCachedPackageEntries,
} from '../../src/indexer/package-entries.js';
import { extractAndPersist } from '../../src/indexer/extract-and-persist.js';
import { isHotChurnPath } from '../../src/utils/hot-churn.js';
import { initContentHasher } from '../../src/util/hash.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';
import { Store } from '../../src/db/store.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';

describe('TRA-2456: event loop stall prevention during reindexing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    await initContentHasher();
    tmpDir = createTmpDir('tra-2456-');
    clearPackageEntriesCache();
  });

  afterEach(() => {
    clearPackageEntriesCache();
    removeTmpDir(tmpDir);
  });

  describe('isHotChurnPath training logs (TRA-2456)', () => {
    it.each([
      'scratchpad/ocr_train/thin/runs/pseudo_x2.log',
      'runs/exp1/train.log',
      'train/val.log',
      'checkpoints/epoch_10/metrics.log',
      'ocr_train/eval.log',
      'C:\\proj\\ocr_train\\runs\\train.log',
      'SCRATCHPAD\\OCR_TRAIN\\PSEUDO_X2.LOG',
    ])('matches ML training log path %s', (p) => {
      expect(isHotChurnPath(p)).toBe(true);
    });

    it.each([
      'src/logger.ts',
      'app/Services/AuditLog.php',
      'docs/changelog.md',
      'logs/app.log', // not under ML_WEIGHT_DIRECTORIES
      'var/log/nginx.log',
    ])('does not match general code or standard non-training paths %s', (p) => {
      expect(isHotChurnPath(p)).toBe(false);
    });
  });

  describe('PACKAGE_SCAN_SKIP_DIRS & directory pruning (TRA-2456)', () => {
    it('contains heavy scratch and data directories', () => {
      expect(PACKAGE_SCAN_SKIP_DIRS.has('scratchpad')).toBe(true);
      expect(PACKAGE_SCAN_SKIP_DIRS.has('storage')).toBe(true);
      expect(PACKAGE_SCAN_SKIP_DIRS.has('runs')).toBe(true);
      expect(PACKAGE_SCAN_SKIP_DIRS.has('checkpoints')).toBe(true);
      expect(PACKAGE_SCAN_SKIP_DIRS.has('dataset')).toBe(true);
      expect(PACKAGE_SCAN_SKIP_DIRS.has('datasets')).toBe(true);
    });

    it('skips package.json files located inside PACKAGE_SCAN_SKIP_DIRS', () => {
      // Legitimate package.json in root and packages/core
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'root', main: 'index.js' }),
      );
      const pkgCoreDir = path.join(tmpDir, 'packages', 'core');
      fs.mkdirSync(pkgCoreDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgCoreDir, 'package.json'),
        JSON.stringify({ name: 'core', main: 'dist/core.js' }),
      );

      // Decoy package.json inside scratchpad, storage, and runs
      for (const skipped of ['scratchpad', 'storage', 'runs', 'checkpoints']) {
        const d = path.join(tmpDir, skipped, 'sub');
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(
          path.join(d, 'package.json'),
          JSON.stringify({ name: `decoy-${skipped}`, main: 'decoy.js' }),
        );
      }

      const entries = findPackageJsonEntries(tmpDir);
      expect(entries).toContain('index.js');
      expect(entries).toContain('packages/core/dist/core.js');

      // None of the decoys should be found
      for (const entry of entries) {
        expect(entry).not.toContain('scratchpad');
        expect(entry).not.toContain('storage');
        expect(entry).not.toContain('runs');
        expect(entry).not.toContain('checkpoints');
      }
    });

    it('stops scanning past MAX_DEPTH (5 levels)', () => {
      // Create a package.json at depth 6
      const deepDir = path.join(tmpDir, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6');
      fs.mkdirSync(deepDir, { recursive: true });
      fs.writeFileSync(
        path.join(deepDir, 'package.json'),
        JSON.stringify({ name: 'too-deep', main: 'deep.js' }),
      );

      // Normal depth (depth 2)
      const normalDir = path.join(tmpDir, 'd1', 'd2');
      fs.writeFileSync(
        path.join(normalDir, 'package.json'),
        JSON.stringify({ name: 'normal', main: 'normal.js' }),
      );

      const entries = findPackageJsonEntries(tmpDir);
      expect(entries).toContain('d1/d2/normal.js');
      expect(entries).not.toContain('d1/d2/d3/d4/d5/d6/deep.js');
    });
  });

  describe('extractAndPersist cold cache fast-path (TRA-2456)', () => {
    it('does not invoke findPackageJsonEntriesAsync when candidate files are < 1 MB and cache is cold', async () => {
      // Create a normal small file
      const filePath = path.join(tmpDir, 'src', 'main.ts');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'console.log("hello");');

      const db = initializeDatabase(':memory:');
      const store = new Store(db);
      const registry = PluginRegistry.createWithDefaults();

      const mockParams = {
        store,
        registry,
        rootPath: tmpDir,
        workspaces: [],
        gitignore: undefined,
        fileContentCache: new Map(),
        buildProjectContext: () =>
          ({
            root: tmpDir,
            rootPath: tmpDir,
            manifests: new Map(),
            workspaces: [],
            dirs: [],
            configFiles: [],
          }) as any,
        getPipelineState: () =>
          ({
            store,
            registry,
            rootPath: tmpDir,
            workspaces: [],
            isIncremental: true,
            changedFileIds: new Set<number>(),
            pendingImports: new Map(),
            fileContentCache: new Map(),
          }) as any,
        maybeGetExtractPool: () => null,
        ftsRebuildThreshold: 1000,
        sortByExtension: (p: string[]) => p,
      };

      expect(readCachedPackageEntries(tmpDir)).toBeUndefined();

      const result = { totalFiles: 1, indexed: 0, skipped: 0, errors: 0 };
      await extractAndPersist(mockParams, ['src/main.ts'], false, result);

      // Package entries walk must NOT have been called for a small file — cache remains unpopulated!
      expect(readCachedPackageEntries(tmpDir)).toBeUndefined();
      db.close();
    });

    it('invokes findPackageJsonEntriesAsync when a candidate file exceeds 1 MB', async () => {
      // Create an oversized file (1.2 MB)
      const bigFilePath = path.join(tmpDir, 'vendor-bundle.js');
      const bigBuffer = Buffer.alloc(1.2 * 1024 * 1024, 'a');
      fs.writeFileSync(bigFilePath, bigBuffer);

      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'my-pkg', main: 'vendor-bundle.js' }),
      );

      const db = initializeDatabase(':memory:');
      const store = new Store(db);
      const registry = PluginRegistry.createWithDefaults();

      const mockParams = {
        store,
        registry,
        rootPath: tmpDir,
        workspaces: [],
        gitignore: undefined,
        fileContentCache: new Map(),
        buildProjectContext: () =>
          ({
            root: tmpDir,
            rootPath: tmpDir,
            manifests: new Map(),
            workspaces: [],
            dirs: [],
            configFiles: [],
          }) as any,
        getPipelineState: () =>
          ({
            store,
            registry,
            rootPath: tmpDir,
            workspaces: [],
            isIncremental: true,
            changedFileIds: new Set<number>(),
            pendingImports: new Map(),
            fileContentCache: new Map(),
          }) as any,
        maybeGetExtractPool: () => null,
        ftsRebuildThreshold: 1000,
        sortByExtension: (p: string[]) => p,
      };

      const result = { totalFiles: 1, indexed: 0, skipped: 0, errors: 0 };
      await extractAndPersist(mockParams, ['vendor-bundle.js'], false, result);

      // Cache should now be populated because > 1MB candidate triggered the scan
      const cached = readCachedPackageEntries(tmpDir);
      expect(cached).toBeDefined();
      expect(cached).toContain('vendor-bundle.js');
      db.close();
    });
  });
});
