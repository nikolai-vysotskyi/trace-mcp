/**
 * TRA-1649: the watcher enqueues directory paths (mkdir/create events for
 * `.multica`, `.opencode/skills/...`, etc.). The pipeline tried to read them
 * as files — `Cannot read file` warnings counted as `errors` in batch
 * telemetry, retried forever. Directories must be `skipped`, never errors,
 * and must not inflate `totalFiles`.
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

describe('TRA-1649 — directories are skipped, not errors', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = createTmpDir('trace-mcp-dir-skip-');
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    // Mirror the issue's live-log paths: nested skill dirs + top-level dir.
    fs.mkdirSync(path.join(tmpRoot, '.opencode', 'skills', 'frontend-design'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.multica'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'a.ts'), 'export const a = 1;\n');
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
      plugins: [],
    };
  }

  it('FileExtractor.extract(dir) returns skipped, not error', async () => {
    const extractor = new FileExtractor({
      store: undefined,
      registry: makeRegistry(),
      rootPath: tmpRoot,
      workspaces: [],
      gitignore: undefined,
      fileContentCache: new Map(),
      buildProjectContext: () => buildProjectContext(tmpRoot),
    });

    for (const dir of ['.multica', '.opencode/skills', '.opencode/skills/frontend-design']) {
      const r = await extractor.extract(dir, false);
      expect(r.kind).toBe('skipped');
    }
  });

  it('indexFiles([file, ...dirs]) counts only the file and reports no errors', async () => {
    const store = createTestStore();
    const pipeline = new IndexingPipeline(store, makeRegistry(), makeConfig(), tmpRoot);
    try {
      const result = await pipeline.indexFiles([
        path.join(tmpRoot, 'src', 'a.ts'),
        path.join(tmpRoot, '.multica'),
        path.join(tmpRoot, '.opencode', 'skills'),
        path.join(tmpRoot, '.opencode', 'skills', 'frontend-design'),
      ]);
      expect(result.totalFiles).toBe(1);
      expect(result.indexed).toBe(1);
      expect(result.errors).toBe(0);
    } finally {
      await pipeline.dispose();
    }
  });

  it('indexFiles([onlyDirs]) is a no-op with zero errors', async () => {
    const store = createTestStore();
    const pipeline = new IndexingPipeline(store, makeRegistry(), makeConfig(), tmpRoot);
    try {
      const result = await pipeline.indexFiles([
        path.join(tmpRoot, '.multica'),
        path.join(tmpRoot, '.opencode', 'skills'),
      ]);
      expect(result.totalFiles).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.indexed).toBe(0);
    } finally {
      await pipeline.dispose();
    }
  });
});
