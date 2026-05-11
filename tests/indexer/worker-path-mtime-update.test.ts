/**
 * Phase 2 Fix 3: when FileExtractor.extract runs in the worker context
 * (no DB handle), the hash-hit branch must surface `mtime_updated` so the
 * main thread can persist the new mtime. Without this the cheap mtime
 * fast-path never re-arms after a hash collision in the worker path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { FileExtractor } from '../../src/indexer/file-extractor.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { buildProjectContext } from '../../src/indexer/project-context.js';
import { initContentHasher } from '../../src/util/hash.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';

describe('FileExtractor — worker-path hash-hit emits mtime_updated', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = createTmpDir('trace-mcp-worker-mtime-');
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    await initContentHasher();
  });

  afterEach(() => {
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
      include: ['src/**/*.ts'],
      exclude: [],
      db: { path: ':memory:' },
      plugins: [],
    };
  }

  it('extract() with ctx.store=undefined returns mtime_updated on hash hit', async () => {
    // First pass: seed the DB via the normal in-process pipeline.
    const store = createTestStore();
    const registry = makeRegistry();
    const pipeline = new IndexingPipeline(store, registry, makeConfig(), tmpRoot);
    const rel = 'src/worker.ts';
    const abs = path.join(tmpRoot, rel);
    fs.writeFileSync(abs, 'export const w = 1;\n');
    await pipeline.indexAll();
    const seeded = store.getFile(rel);
    expect(seeded).toBeDefined();
    const originalMtime = seeded!.mtime_ms;
    const originalHash = seeded!.content_hash;
    expect(originalHash).toBeTruthy();

    // Bump mtime without changing content (formatter touch).
    const newMtimeSec = Math.floor(fs.statSync(abs).mtimeMs / 1000) + 30;
    fs.utimesSync(abs, newMtimeSec, newMtimeSec);
    const newMtimeMs = newMtimeSec * 1000;
    expect(newMtimeMs).not.toBe(originalMtime);

    // Worker-style FileExtractor: NO store, existing supplied via opts.
    const workerExtractor = new FileExtractor({
      store: undefined,
      registry,
      rootPath: tmpRoot,
      workspaces: [],
      gitignore: undefined,
      fileContentCache: new Map(),
      buildProjectContext: () => buildProjectContext(tmpRoot),
    });

    const r = await workerExtractor.extract(rel, false, {
      existing: seeded ?? null,
      gitignored: false,
    });

    expect(r.kind).toBe('mtime_updated');
    if (r.kind !== 'mtime_updated') return; // type guard for TS
    expect(r.fileId).toBe(seeded!.id);
    expect(r.newMtimeMs).toBe(Math.floor(newMtimeMs));

    // The DB row must NOT have been touched by the worker — the main thread
    // is responsible for the persist step. Sanity-check that explicitly.
    const stillStale = store.getFile(rel);
    expect(stillStale!.mtime_ms).toBe(originalMtime);

    // Now simulate the main-thread handler: store.updateFileMtime(...)
    // and assert hash unchanged + mtime persisted.
    store.updateFileMtime(r.fileId, r.newMtimeMs);
    const after = store.getFile(rel)!;
    expect(after.content_hash).toBe(originalHash);
    expect(after.mtime_ms).toBe(Math.floor(newMtimeMs));
  });

  it('in-process extractor (with ctx.store) writes directly and returns skipped', async () => {
    const store = createTestStore();
    const registry = makeRegistry();
    const pipeline = new IndexingPipeline(store, registry, makeConfig(), tmpRoot);
    const rel = 'src/inproc.ts';
    const abs = path.join(tmpRoot, rel);
    fs.writeFileSync(abs, 'export const x = 1;\n');
    await pipeline.indexAll();
    const before = store.getFile(rel)!;

    const newMtimeSec = Math.floor(fs.statSync(abs).mtimeMs / 1000) + 30;
    fs.utimesSync(abs, newMtimeSec, newMtimeSec);
    const newMtimeMs = newMtimeSec * 1000;

    // In-process extractor with the real store handle.
    const inProcExtractor = new FileExtractor({
      store,
      registry,
      rootPath: tmpRoot,
      workspaces: [],
      gitignore: undefined,
      fileContentCache: new Map(),
      buildProjectContext: () => buildProjectContext(tmpRoot),
    });

    const r = await inProcExtractor.extract(rel, false, {
      existing: before,
      gitignored: false,
    });
    expect(r.kind).toBe('skipped');
    const after = store.getFile(rel)!;
    expect(after.mtime_ms).toBe(Math.floor(newMtimeMs));
    expect(after.content_hash).toBe(before.content_hash);
  });
});
