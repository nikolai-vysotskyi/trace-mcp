/**
 * Tests that the IndexingPipeline detects file renames by content hash and
 * carries existing symbols/edges over to the new path instead of re-extracting.
 * graphify v0.7.0 made the same optimization by removing path from its cache key.
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

describe('IndexingPipeline — rename detection by content hash', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-rename-'));
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

  it('preserves the file row id when content moves to a new path', async () => {
    const { store, pipeline } = makePipeline();

    const oldRel = 'src/old-name.ts';
    const newRel = 'src/new-name.ts';
    const content = 'export function alpha() { return 1; }\n';

    fs.writeFileSync(path.join(tmpRoot, oldRel), content);
    await pipeline.indexAll();

    const before = store.getFile(oldRel);
    expect(before).toBeDefined();
    const originalId = before!.id;

    // Simulate a rename: move the file to a new path with identical content.
    fs.renameSync(path.join(tmpRoot, oldRel), path.join(tmpRoot, newRel));

    await pipeline.indexAll();

    const stale = store.getFile(oldRel);
    expect(stale).toBeUndefined();

    const after = store.getFile(newRel);
    expect(after).toBeDefined();
    expect(after!.id).toBe(originalId); // same row, just relabelled
    expect(after!.content_hash).toBe(before!.content_hash);
  });

  it('does not rename when the original path still exists on disk', async () => {
    const { store, pipeline } = makePipeline();

    const a = 'src/identical-a.ts';
    const b = 'src/identical-b.ts';
    const content = 'export const sameContent = 42;\n';

    // Two files with identical content from the start. The detector must
    // never collapse them — both are real, independent files.
    fs.writeFileSync(path.join(tmpRoot, a), content);
    await pipeline.indexAll();

    const idA = store.getFile(a)!.id;

    fs.writeFileSync(path.join(tmpRoot, b), content);
    await pipeline.indexAll();

    expect(store.getFile(a)?.id).toBe(idA); // unchanged
    expect(store.getFile(b)).toBeDefined();
    expect(store.getFile(b)!.id).not.toBe(idA);
  });

  it('falls through to normal extraction when content hash differs', async () => {
    const { store, pipeline } = makePipeline();

    const oldRel = 'src/foo.ts';
    const newRel = 'src/bar.ts';
    fs.writeFileSync(path.join(tmpRoot, oldRel), 'export const x = 1;\n');
    await pipeline.indexAll();

    const oldId = store.getFile(oldRel)!.id;

    fs.unlinkSync(path.join(tmpRoot, oldRel));
    // Content differs slightly — must not be treated as a rename.
    fs.writeFileSync(path.join(tmpRoot, newRel), 'export const y = 2;\n');

    await pipeline.indexAll();

    expect(store.getFile(newRel)).toBeDefined();
    expect(store.getFile(newRel)!.id).not.toBe(oldId);
  });
});
