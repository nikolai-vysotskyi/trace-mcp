import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { IndexingPipeline, readIndexTruncation } from '../pipeline.js';
import { collectFiles } from '../file-collector.js';
import { getIndexHealth } from '../../tools/project/project.js';
import { verifyIndex } from '../../db/verify.js';
import { TypeScriptLanguagePlugin } from '../plugins/language/typescript/index.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { createTestStore } from '../../../tests/test-utils.js';
import { logger } from '../../logger.js';

describe('TRA-2639: truncation stability, coverage reconcile loop prevention, and partial index signals', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-tra2639-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('collectFiles sorts files deterministically when truncating to maxFiles', async () => {
    // Create files in reverse/mixed order
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'z.ts'), 'export const z = 1;');
    fs.writeFileSync(path.join(tempDir, 'src', 'm.ts'), 'export const m = 1;');
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(tempDir, 'src', 'b.ts'), 'export const b = 1;');

    const config = TraceMcpConfigSchema.parse({
      root: tempDir,
      include: ['src/**/*.ts'],
      exclude: [],
      security: { max_files: 2 },
    });

    const run1 = await collectFiles({
      config,
      rootPath: tempDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 2,
    });

    const run2 = await collectFiles({
      config,
      rootPath: tempDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 2,
    });

    expect(run1.truncated).toBe(true);
    expect(run1.found).toBe(4);
    expect(run1.limit).toBe(2);
    expect(run1.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(run2.files).toEqual(run1.files);
  });

  it('collectFiles suppresses warning log when warnOnTruncate is false', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(tempDir, 'src', 'b.ts'), 'export const b = 1;');

    const config = TraceMcpConfigSchema.parse({
      root: tempDir,
      include: ['src/**/*.ts'],
      exclude: [],
      security: { max_files: 1 },
    });

    const warnSpy = vi.spyOn(logger, 'warn');

    // 1. With warnOnTruncate: false -> no logger.warn
    const quietResult = await collectFiles({
      config,
      rootPath: tempDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 1,
      warnOnTruncate: false,
    });
    expect(quietResult.truncated).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();

    // 2. Default (warnOnTruncate undefined) -> logger.warn is called
    const loudResult = await collectFiles({
      config,
      rootPath: tempDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 1,
    });
    expect(loudResult.truncated).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1, found: 2 }),
      expect.stringContaining('File count exceeds limit'),
    );

    warnSpy.mockRestore();
  });

  it('collectFiles skips deep-pattern fallback when workspaces match rooted patterns', async () => {
    // Monorepo layout: project root has no src/**, but ws1/src/** exists
    const wsPath = path.join(tempDir, 'packages', 'ws1');
    fs.mkdirSync(path.join(wsPath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'src', 'foo.ts'), 'export const foo = 1;');

    const config = TraceMcpConfigSchema.parse({
      root: tempDir,
      include: ['src/**/*.ts'],
      exclude: [],
    });

    const infoSpy = vi.spyOn(logger, 'info');

    const result = await collectFiles({
      config,
      rootPath: tempDir,
      workspaces: [{ name: 'ws1', path: 'packages/ws1' }],
      traceignore: undefined,
      maxFiles: 100,
    });

    expect(result.files).toEqual(['packages/ws1/src/foo.ts']);
    // Deep-pattern fallback was not triggered because wsEntries matched
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(
        'Rooted include patterns found nothing at project root — using deep glob patterns',
      ),
    );

    infoSpy.mockRestore();
  });

  it('coverage reconcile does not trigger loop or reindex when index is already saturated at maxFiles', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    // Write 5 files with max_files = 2
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tempDir, 'src', `f${i}.ts`), `export const v${i} = ${i};`);
    }

    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = TraceMcpConfigSchema.parse({
      root: tempDir,
      include: ['src/**/*.ts'],
      exclude: [],
      security: { max_files: 2 },
    });

    const pipeline = new IndexingPipeline(store, registry, config, tempDir, undefined, {
      coverageReconcileDebounceMs: 10 * 60_000,
    });

    // 1. Initial index cuts to 2 files and stamps metadata
    await pipeline.indexAll();
    expect(store.getStats().totalFiles).toBe(2);
    expect(readIndexTruncation(store)).toEqual({ found: 5, limit: 2 });

    // 2. Watcher churn occurs (e.g. file modified)
    fs.writeFileSync(path.join(tempDir, 'src', 'f0.ts'), 'export const v0 = 999;');
    await pipeline.indexFiles(['src/f0.ts']);
    expect(store.getStats().totalFiles).toBe(2);

    // 3. Coverage reconcile fires: should NOT trigger indexAll because index is already saturated at max_files
    const indexAllSpy = vi.spyOn(pipeline, 'indexAll');
    await pipeline.__flushCoverageReconcileForTests();

    expect(indexAllSpy).not.toHaveBeenCalled();
    expect(store.getStats().totalFiles).toBe(2);

    await pipeline.dispose();
  });

  it('coverage reconcile does not trigger indexAll on negative gap when walk is truncated', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    for (let i = 0; i < 4; i++) {
      fs.writeFileSync(path.join(tempDir, 'src', `item${i}.ts`), `export const x${i} = ${i};`);
    }

    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = TraceMcpConfigSchema.parse({
      root: tempDir,
      include: ['src/**/*.ts'],
      exclude: [],
      security: { max_files: 2 },
    });

    const pipeline = new IndexingPipeline(store, registry, config, tempDir, undefined, {
      coverageReconcileDebounceMs: 10 * 60_000,
    });

    // Seed 3 existing rows into DB (e.g. from an earlier less-constrained run)
    // onDisk will be capped at 2, while indexed is 3 -> gap = 2 - 3 = -1 (< 0)
    await pipeline.indexAll();
    // Simulate extra file in DB past cap
    store.insertFile('src/item2.ts', 'typescript', 'hash2', 10, null, null);
    expect(store.getStats().totalFiles).toBe(3);

    const indexAllSpy = vi.spyOn(pipeline, 'indexAll');
    await pipeline.__flushCoverageReconcileForTests();

    // Since walk is truncated and gap <= 0, it must NOT trigger indexAll
    expect(indexAllSpy).not.toHaveBeenCalled();

    await pipeline.dispose();
  });

  it('getIndexHealth surfaces degraded status, warning, and truncated object when index is partial', () => {
    const store = createTestStore();
    const config = TraceMcpConfigSchema.parse({
      root: tempDir,
      include: ['src/**/*.ts'],
      exclude: [],
      security: { max_files: 1000 },
    });

    // 1. Healthy untruncated index
    store.insertFile('src/a.ts', 'typescript', 'h1', 10, null, null);
    store.insertFile('src/b.ts', 'typescript', 'h2', 20, null, null);
    const healthBefore = getIndexHealth(store, config, tempDir);
    expect(healthBefore.status).toBe('ok');
    expect(healthBefore.truncated).toBeUndefined();

    // 2. Truncated index stamped in metadata
    store.setRepoMetadata('index_truncated', '1');
    store.setRepoMetadata('index_truncated_found', '24226');
    store.setRepoMetadata('index_truncated_limit', '10000');

    const healthAfter = getIndexHealth(store, config, tempDir);
    expect(healthAfter.status).toBe('degraded');
    expect(healthAfter.truncated).toEqual({ found: 24226, limit: 10000 });
    expect(
      healthAfter.warnings.some((w) =>
        w.includes('File count exceeds security.max_files limit (24226 found, capped at 10000)'),
      ),
    ).toBe(true);
  });

  it('verifyIndex reports index_truncation check status warn when truncated', () => {
    const store = createTestStore();

    // Untruncated index -> ok
    const reportOk = verifyIndex(store.db);
    const checkOk = reportOk.checks.find((c) => c.name === 'index_truncation');
    expect(checkOk).toBeDefined();
    expect(checkOk?.status).toBe('ok');

    // Truncated index -> warn
    store.setRepoMetadata('index_truncated', '1');
    store.setRepoMetadata('index_truncated_found', '15000');
    store.setRepoMetadata('index_truncated_limit', '10000');

    const reportWarn = verifyIndex(store.db);
    const checkWarn = reportWarn.checks.find((c) => c.name === 'index_truncation');
    expect(checkWarn).toBeDefined();
    expect(checkWarn?.status).toBe('warn');
    expect(checkWarn?.detail).toContain(
      'Index is truncated by security.max_files: 15000 file(s) found on disk, capped at 10000',
    );
    expect(checkWarn?.suggested_repair).toBe(
      'increase security.max_files in config and run reindex',
    );
  });
});
