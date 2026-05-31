/**
 * Regression: a single index of a "folder of projects" container (vestigial root
 * manifest, nested subprojects) must DISCOVER the nested subprojects' files.
 *
 * The directory-rooted include globs (src/**, app/**, routes/**) only match at
 * the container root, and the entries===0 deep-glob fallback never fires when a
 * stray root file (README, **\/*.md) matched first. With workspaces detected,
 * collectFiles now also globs the include patterns anchored to each workspace.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { createTmpDir, removeTmpDir, writeFixtureFile } from '../test-utils.js';
import { createTestStore } from '../test-utils.js';

describe('monorepo nested file discovery', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    store = createTestStore();
    tmpDir = createTmpDir('trace-mcp-mono-discovery-');
  });
  afterEach(() => removeTmpDir(tmpDir));

  it('discovers nested subproject files under a vestigial root manifest', async () => {
    // Vestigial root manifest (no workspaces) + a stray root README that makes
    // the first include pass non-empty (so the old deep-glob fallback won't fire).
    writeFixtureFile(tmpDir, 'package.json', '{"dependencies":{"tinymce":"^6"}}');
    writeFixtureFile(tmpDir, 'README.md', '# container\n');
    // Two nested projects, each a recognizable workspace (has its own manifest),
    // with code under directory-rooted include globs (src/**, app/**).
    writeFixtureFile(tmpDir, 'shopA/shopA-front/package.json', '{"name":"a-front"}');
    writeFixtureFile(tmpDir, 'shopA/shopA-front/src/index.ts', 'export const a = 1;\n');
    writeFixtureFile(tmpDir, 'shopB/shopB-front/package.json', '{"name":"b-front"}');
    writeFixtureFile(tmpDir, 'shopB/shopB-front/app/main.ts', 'export const b = 2;\n');

    const config = {
      root: tmpDir,
      // The repo's real default globs are directory-rooted (src/**, app/**).
      include: ['src/**/*.ts', 'app/**/*.ts', '**/*.md'],
      exclude: ['**/node_modules/**'],
      db: { path: ':memory:' },
      plugins: [],
    } as never;

    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const pipeline = new IndexingPipeline(store, registry, config, tmpDir);
    const result = await pipeline.indexAll();
    expect(result.errors).toBe(0);

    const paths = (
      store.db.prepare("SELECT path FROM files WHERE language = 'typescript'").all() as Array<{
        path: string;
      }>
    ).map((r) => r.path);

    // Both nested subprojects' files are discovered despite the root-anchored globs.
    expect(paths).toContain('shopA/shopA-front/src/index.ts');
    expect(paths).toContain('shopB/shopB-front/app/main.ts');
  });
});
