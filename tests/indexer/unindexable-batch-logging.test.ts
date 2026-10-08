/**
 * TRA-2273: Indexer clutters daemon.log with expected skip warnings:
 * 1056 L40 entries in 18 hours (Binary file detected, skipping and
 * File too large, skipping).
 *
 * Requirements:
 * 1. Expected skipping of binary and oversized files must be tracked
 *    by indexing counters (skipped, skippedBinary, skippedOversize).
 * 2. Do not log each new file at WARN level (logs go to DEBUG).
 * 3. Bounded aggregated summary is available on indexing result.
 * 4. Genuine unusual failures (e.g. Cannot read file) MUST still warn
 *    and count as errors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { resetFileTooLargeWarnDedupForTests } from '../../src/indexer/file-extractor.js';
import {
  getUnindexableSkipStats,
  getUnindexableVerdicts,
  resetUnindexableSkipCacheForTests,
} from '../../src/indexer/unindexable-skip-cache.js';
import { logger } from '../../src/logger.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { getIndexHealth } from '../../src/tools/project/project.js';
import { initContentHasher } from '../../src/util/hash.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';

describe('TRA-2273 — Expected skip logging level & batch aggregation', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = createTmpDir('trace-mcp-unindexable-batch-');
    resetFileTooLargeWarnDedupForTests();
    resetUnindexableSkipCacheForTests();
    await initContentHasher();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeTmpDir(tmpRoot);
  });

  function makeRegistry(): PluginRegistry {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    return registry;
  }

  function makeConfig(): TraceMcpConfig {
    return {
      root: tmpRoot,
      include: ['**/*'],
      exclude: ['node_modules/**'],
      plugins: [],
    };
  }

  it('batch of binary and oversized files emits zero warn logs, accounts in skipped counters, and preserves unusual read errors', async () => {
    const store = createTestStore();
    const pipeline = new IndexingPipeline(store, makeRegistry(), makeConfig(), tmpRoot);

    // Create 10 binary files (e.g. .pt model weights and .png icons with null bytes)
    const binaryDir = path.join(tmpRoot, 'artifacts');
    fs.mkdirSync(binaryDir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      const binBuffer = Buffer.alloc(1024);
      binBuffer[10] = 0; // null byte in first 8KB makes it binary
      binBuffer.write(`binary artifact ${i}`, 20);
      fs.writeFileSync(path.join(binaryDir, `model_${i}.pt`), binBuffer);
    }

    // Create 10 oversized files (> 1 MB default ceiling)
    const largeDir = path.join(tmpRoot, 'logs');
    fs.mkdirSync(largeDir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(largeDir, `run_${i}.jsonl`), `${'x'.repeat(1_100_000)}\n`);
    }

    // Create 2 normal TypeScript files
    const srcDir = path.join(tmpRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const hello = "world";\n');
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      'export function add(a: number, b: number) { return a + b; }\n',
    );

    // Create 1 file that will fail to read (simulating an unusual failure: EACCES / Cannot read file)
    const unreadablePath = path.join(srcDir, 'unreadable.ts');
    fs.writeFileSync(unreadablePath, 'export const secret = 1;\n');

    const origReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((targetPath, options) => {
      if (typeof targetPath === 'string' && targetPath.endsWith('unreadable.ts')) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return origReadFileSync(targetPath, options);
    });

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);

    try {
      const result = await pipeline.indexAll(true);

      // 1. Verify indexing counters
      expect(result.indexed).toBe(2); // index.ts, utils.ts
      expect(result.skipped).toBe(20); // 10 binary + 10 oversize
      expect(result.skippedBinary).toBe(10);
      expect(result.skippedOversize).toBe(10);
      expect(result.errors).toBe(1); // unreadable.ts

      // 2. Zero warn logs for binary and oversized skips
      const skipWarnCalls = warnSpy.mock.calls.filter(
        ([, msg]) =>
          typeof msg === 'string' &&
          (msg.includes('Binary file') || msg.includes('File too large')),
      );
      expect(skipWarnCalls).toHaveLength(0);

      // 3. Warning IS preserved for the unusual failure (Cannot read file)
      const readErrorWarnCalls = warnSpy.mock.calls.filter(([, msg]) => msg === 'Cannot read file');
      expect(readErrorWarnCalls).toHaveLength(1);
      const [warnMeta] = readErrorWarnCalls[0] as [Record<string, unknown>, string];
      expect(warnMeta['code']).toBe('EACCES');
      expect(warnMeta['file']).toBe('src/unreadable.ts');

      // 4. Debug logs capture individual skipped files for diagnostics
      const binaryDebugCalls = debugSpy.mock.calls.filter(
        ([, msg]) => typeof msg === 'string' && msg.includes('Binary file detected'),
      );
      expect(binaryDebugCalls.length).toBeGreaterThanOrEqual(10);

      const oversizeDebugCalls = debugSpy.mock.calls.filter(
        ([, msg]) => typeof msg === 'string' && msg.includes('File too large'),
      );
      expect(oversizeDebugCalls.length).toBeGreaterThanOrEqual(10);
    } finally {
      readSpy.mockRestore();
      await pipeline.dispose();
    }
  });

  it('repeated reconcile of oversized and binary files suppresses debug repeat without warnings', async () => {
    const store = createTestStore();
    const pipeline = new IndexingPipeline(store, makeRegistry(), makeConfig(), tmpRoot);

    const binFile = path.join(tmpRoot, 'test.pt');
    const largeFile = path.join(tmpRoot, 'test.jsonl');

    const binBuf = Buffer.alloc(500);
    binBuf[5] = 0;
    fs.writeFileSync(binFile, binBuf);
    fs.writeFileSync(largeFile, `${'z'.repeat(1_200_000)}\n`);

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);

    try {
      // First pass
      const r1 = await pipeline.indexFiles([binFile, largeFile]);
      expect(r1.totalFiles).toBe(2);
      expect(r1.indexed).toBe(0);
      expect(r1.skipped).toBe(2);
      expect(r1.skippedBinary).toBe(1);
      expect(r1.skippedOversize).toBe(1);

      // Second pass (repeated event on growing file and same binary)
      fs.appendFileSync(largeFile, `${'z'.repeat(100_000)}\n`);
      const r2 = await pipeline.indexFiles([binFile, largeFile]);
      expect(r2.totalFiles).toBe(2);
      expect(r2.indexed).toBe(0);
      expect(r2.skipped).toBe(2);
      expect(r2.skippedBinary).toBe(1);
      expect(r2.skippedOversize).toBe(1);

      expect(warnSpy).not.toHaveBeenCalled();

      // Debug has records for both initial skip and repeats
      expect(debugSpy).toHaveBeenCalled();
      const repeatCalls = debugSpy.mock.calls.filter(
        ([, msg]) => typeof msg === 'string' && msg.includes('repeat suppressed'),
      );
      expect(repeatCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      await pipeline.dispose();
    }
  });

  it('indexFiles accounts skipped binary and oversize counters on repeated calls and surfaces in diagnostics', async () => {
    const store = createTestStore();
    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, makeRegistry(), config, tmpRoot);

    const binFile = path.join(tmpRoot, 'model.pt');
    const binBuf = Buffer.alloc(1024);
    binBuf[0] = 0;
    fs.writeFileSync(binFile, binBuf);

    const largeFile = path.join(tmpRoot, 'scratch.jsonl');
    fs.writeFileSync(largeFile, `${'a'.repeat(1_200_000)}\n`);

    const normalFile = path.join(tmpRoot, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(normalFile), { recursive: true });
    fs.writeFileSync(normalFile, 'export const ready = true;\n');

    try {
      // 1. Calling indexFiles twice with the same binary file:
      const b1 = await pipeline.indexFiles([binFile]);
      expect(b1.totalFiles).toBe(1);
      expect(b1.indexed).toBe(0);
      expect(b1.skipped).toBe(1);
      expect(b1.skippedBinary).toBe(1);
      expect(b1.skippedOversize).toBeUndefined();

      const b2 = await pipeline.indexFiles([binFile]);
      expect(b2.totalFiles).toBe(1);
      expect(b2.indexed).toBe(0);
      expect(b2.skipped).toBe(1);
      expect(b2.skippedBinary).toBe(1);
      expect(b2.skippedOversize).toBeUndefined();

      // 2. Calling indexFiles twice with the same oversized file:
      const o1 = await pipeline.indexFiles([largeFile]);
      expect(o1.totalFiles).toBe(1);
      expect(o1.indexed).toBe(0);
      expect(o1.skipped).toBe(1);
      expect(o1.skippedOversize).toBe(1);
      expect(o1.skippedBinary).toBeUndefined();

      const o2 = await pipeline.indexFiles([largeFile]);
      expect(o2.totalFiles).toBe(1);
      expect(o2.indexed).toBe(0);
      expect(o2.skipped).toBe(1);
      expect(o2.skippedOversize).toBe(1);
      expect(o2.skippedBinary).toBeUndefined();

      // 3. Mixed batch with normal file and unindexables:
      const m1 = await pipeline.indexFiles([binFile, largeFile, normalFile]);
      expect(m1.totalFiles).toBe(3);
      expect(m1.indexed).toBe(1);
      expect(m1.skipped).toBe(2);
      expect(m1.skippedBinary).toBe(1);
      expect(m1.skippedOversize).toBe(1);

      // Re-running mixed batch: normal file is unchanged (skipped by mtime prefilter), unindexables skipped
      const m2 = await pipeline.indexFiles([binFile, largeFile, normalFile]);
      expect(m2.totalFiles).toBe(3);
      expect(m2.indexed).toBe(0);
      expect(m2.skipped).toBe(3); // 1 unchanged prefiltered + 1 binary + 1 oversize
      expect(m2.skippedBinary).toBe(1);
      expect(m2.skippedOversize).toBe(1);

      // 4. Verify diagnostics accessor
      const stats = getUnindexableSkipStats(tmpRoot);
      expect(stats.totalEntries).toBe(2);
      expect(stats.byReason.binary).toBe(1);
      expect(stats.byReason.oversize).toBe(1);

      const verdicts = getUnindexableVerdicts(tmpRoot);
      expect(verdicts).toHaveLength(2);
      expect(verdicts.map((v) => v.reason).sort()).toEqual(['binary', 'oversize']);

      // 5. Verify getIndexHealth surfaces unindexableSkips
      const health = getIndexHealth(store, config, tmpRoot);
      expect(health.unindexableSkips).toEqual({
        total: 2,
        binary: 1,
        oversize: 1,
      });
    } finally {
      await pipeline.dispose();
    }
  });
});
