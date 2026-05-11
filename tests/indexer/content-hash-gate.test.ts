/**
 * Verifies the content-hash second-filter gate inside FileExtractor:
 *   - mtime-only fast-path still wins when mtime is unchanged.
 *   - mtime drift + identical content → skipped + mtime row updated.
 *   - mtime drift + different content → re-extract + content_hash updated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTestStore } from '../test-utils.js';

describe('FileExtractor — content-hash gate after mtime fast-path', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-hash-gate-'));
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makePipeline() {
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config: TraceMcpConfig = {
      root: tmpRoot,
      include: ['src/**/*.ts'],
      exclude: [],
      db: { path: ':memory:' },
      plugins: [],
    };
    return { store, pipeline: new IndexingPipeline(store, registry, config, tmpRoot) };
  }

  function bumpMtime(abs: string, deltaSec = 5): number {
    const stat = fs.statSync(abs);
    const newMtimeSec = Math.floor(stat.mtimeMs / 1000) + deltaSec;
    fs.utimesSync(abs, newMtimeSec, newMtimeSec);
    return newMtimeSec * 1000;
  }

  it('persists content_hash on first index', async () => {
    const { store, pipeline } = makePipeline();
    const rel = 'src/a.ts';
    fs.writeFileSync(path.join(tmpRoot, rel), 'export const a = 1;\n');
    await pipeline.indexAll();
    const row = store.getFile(rel);
    expect(row).toBeDefined();
    expect(row!.content_hash).toBeTruthy();
    expect(row!.content_hash!.length).toBeGreaterThan(0);
  });

  it('mtime-touched-but-content-identical → skipped + mtime updated', async () => {
    const { store, pipeline } = makePipeline();
    const rel = 'src/touch.ts';
    const abs = path.join(tmpRoot, rel);
    fs.writeFileSync(abs, 'export const touch = 1;\n');
    const first = await pipeline.indexAll();
    expect(first.indexed).toBe(1);

    const before = store.getFile(rel)!;
    const originalHash = before.content_hash;
    const originalMtime = before.mtime_ms;
    expect(originalMtime).not.toBeNull();

    // Bump mtime without changing content (formatter-on-save / git checkout).
    const newMtimeMs = bumpMtime(abs, 10);
    expect(newMtimeMs).not.toBe(originalMtime);

    const second = await pipeline.indexAll();
    expect(second.skipped).toBeGreaterThanOrEqual(1);
    expect(second.indexed).toBe(0);

    const after = store.getFile(rel)!;
    expect(after.content_hash).toBe(originalHash);
    expect(after.mtime_ms).toBe(Math.floor(newMtimeMs));
  });

  it('content changes → re-extract and content_hash changes in DB', async () => {
    const { store, pipeline } = makePipeline();
    const rel = 'src/edit.ts';
    const abs = path.join(tmpRoot, rel);
    fs.writeFileSync(abs, 'export const v = 1;\n');
    await pipeline.indexAll();
    const before = store.getFile(rel)!;
    const oldHash = before.content_hash;

    fs.writeFileSync(abs, 'export const v = 2;\n');
    bumpMtime(abs, 20);

    const r = await pipeline.indexAll();
    expect(r.indexed).toBe(1);
    const after = store.getFile(rel)!;
    expect(after.content_hash).not.toBe(oldHash);
  });
});
