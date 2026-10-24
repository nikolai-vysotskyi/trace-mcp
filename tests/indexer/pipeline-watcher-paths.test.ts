/**
 * Watcher-path batch hygiene: `indexFiles()` is the event-driven entry point
 * (watcher live events, hooks, `register_edit`, HTTP reindex-file). Batches
 * arriving here can name directories (a watcher reports the dir alongside —
 * or instead of — its contents), and those must be skipped, never counted
 * as indexing errors.
 *
 * Live evidence (installed daemon 3.27.1, 2026-09-18): an 85-file batch with
 * 18 directory paths completed as `{ indexed: 67, errors: 18 }` with eighteen
 * `Cannot read file` warns — and retried with the same 18 errors. TRA-1649.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { search } from '../../src/tools/navigation/navigation.js';
import { createTestStore, createTmpFixture, removeTmpDir } from '../test-utils.js';

describe('indexFiles() — directory entries in the batch', () => {
  let root: string;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeAll(async () => {
    root = createTmpFixture(
      {
        'src/alpha.ts': 'export function alpha() { return 1; }\n',
        'sub/nested.ts': 'export function nested() { return 2; }\n',
      },
      'trace-mcp-watcher-dirs-',
    );
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.ts'],
      exclude: ['node_modules/**'],
    });
    pipeline = new IndexingPipeline(store, registry, config, root);
  }, 120_000);

  afterAll(() => removeTmpDir(root));

  it('indexes the real file in a mixed batch', async () => {
    const result = await pipeline.indexFiles(['src/alpha.ts', 'sub']);
    expect(result.indexed).toBeGreaterThanOrEqual(1);
    const found = await search(store, 'alpha', { kind: 'function' }, 10, 0, {});
    expect(found.items.map((i) => i.symbol.name)).toContain('alpha');
  });

  it('directories are skipped without counting errors (TRA-1649, fixed by #1259)', async () => {
    const result = await pipeline.indexFiles(['src/alpha.ts', 'sub']);
    expect(result.errors).toBe(0);
    const paths = store.getAllFiles().map((f) => f.path);
    expect(paths.some((p) => p === 'sub')).toBe(false);
  });
});

describe('indexFiles() — full-walk include gates', () => {
  let root: string;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeAll(() => {
    root = createTmpFixture({
      'src/allowed.ts': 'export const allowed = 1;\n',
      'src/i18n/en.json': '{"extra": 1}\n',
      'docs/outside.md': '# Outside\n',
      '.hidden/secret.ts': 'export const secret = 1;\n',
      'src/.hidden/secret.ts': 'export const nestedSecret = 1;\n',
      'vendor/src/extra.ts': 'export const extra = 1;\n',
    });
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    pipeline = new IndexingPipeline(
      store,
      registry,
      TraceMcpConfigSchema.parse({ include: ['src/**/*.ts'], exclude: [] }),
      root,
    );
  });

  afterAll(() => removeTmpDir(root));

  it('rejects files outside include, including JSON data and Markdown', async () => {
    const result = await pipeline.indexFiles(['src/i18n/en.json', 'docs/outside.md']);
    expect(result.indexed).toBe(0);
    expect(result.totalFiles).toBe(0);
    expect(store.getAllFiles()).toEqual([]);
  });

  it('rejects dot directories while retaining included source files', async () => {
    const result = await pipeline.indexFiles([
      '.hidden/secret.ts',
      'src/.hidden/secret.ts',
      'src/allowed.ts',
    ]);
    expect(result.indexed).toBe(1);
    expect(store.getAllFiles().map((f) => f.path)).toEqual(['src/allowed.ts']);
  });

  it('does not use the deep fallback when rooted include paths exist', async () => {
    const result = await pipeline.indexFiles(['vendor/src/extra.ts']);
    expect(result.totalFiles).toBe(0);
    expect(store.getAllFiles().map((f) => f.path)).toEqual(['src/allowed.ts']);
  });
});

describe('indexFiles() — negated include globs', () => {
  it('applies negations without admitting unrelated paths', async () => {
    const root = createTmpFixture({
      'src/allowed.ts': 'export const allowed = 1;\n',
      'src/generated/extra.ts': 'export const extra = 1;\n',
      'docs/outside.md': '# Outside\n',
    });
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const pipeline = new IndexingPipeline(
      store,
      registry,
      TraceMcpConfigSchema.parse({
        include: ['src/**/*.ts', '!src/generated/**'],
        exclude: [],
      }),
      root,
    );
    try {
      const result = await pipeline.indexFiles([
        'src/generated/extra.ts',
        'docs/outside.md',
        'src/allowed.ts',
      ]);
      expect(result.indexed).toBe(1);
      expect(store.getAllFiles().map((f) => f.path)).toEqual(['src/allowed.ts']);
    } finally {
      await pipeline.dispose();
      removeTmpDir(root);
    }
  });

  it('keeps a leading negative extglob as a positive include', async () => {
    const root = createTmpFixture({ 'src/allowed.ts': 'export const allowed = 1;\n' });
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const pipeline = new IndexingPipeline(
      store,
      registry,
      TraceMcpConfigSchema.parse({ include: ['!(test)/**/*.ts'], exclude: [] }),
      root,
    );
    try {
      expect((await pipeline.indexFiles(['src/allowed.ts'])).indexed).toBe(1);
    } finally {
      await pipeline.dispose();
      removeTmpDir(root);
    }
  });
});

describe('indexFiles() — rooted include fallback', () => {
  it('accepts a nested source when the full walk has no root match', async () => {
    const root = createTmpFixture({
      'nested/src/deep.ts': 'export const deep = 1;\n',
    });
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const pipeline = new IndexingPipeline(
      store,
      registry,
      TraceMcpConfigSchema.parse({ include: ['src/**/*.ts'], exclude: [] }),
      root,
    );
    try {
      const result = await pipeline.indexFiles(['nested/src/deep.ts']);
      expect(result.indexed).toBe(1);
      expect(store.getAllFiles().map((f) => f.path)).toEqual(['nested/src/deep.ts']);
    } finally {
      await pipeline.dispose();
      removeTmpDir(root);
    }
  });

  it('ignores root matches in built-in skipped directories', async () => {
    const root = createTmpFixture({
      'build/output.ts': 'export const built = 1;\n',
      'nested/src/deep.ts': 'export const deep = 1;\n',
    });
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const pipeline = new IndexingPipeline(
      store,
      registry,
      TraceMcpConfigSchema.parse({ include: ['src/**/*.ts', 'build/**/*.ts'], exclude: [] }),
      root,
    );
    try {
      expect((await pipeline.indexFiles(['build/output.ts', 'nested/src/deep.ts'])).indexed).toBe(
        1,
      );
      expect(store.getAllFiles().map((f) => f.path)).toEqual(['nested/src/deep.ts']);
    } finally {
      await pipeline.dispose();
      removeTmpDir(root);
    }
  });

  it('respects the full walk depth limit', async () => {
    const root = createTmpFixture({
      'a/b/c/src/allowed.ts': 'export const allowed = 1;\n',
      'a/b/c/d/src/tooDeep.ts': 'export const tooDeep = 1;\n',
    });
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const pipeline = new IndexingPipeline(
      store,
      registry,
      TraceMcpConfigSchema.parse({ include: ['src/**/*.ts'], exclude: [] }),
      root,
    );
    try {
      const result = await pipeline.indexFiles(['a/b/c/src/allowed.ts', 'a/b/c/d/src/tooDeep.ts']);
      expect(result.indexed).toBe(1);
      expect(store.getAllFiles().map((f) => f.path)).toEqual(['a/b/c/src/allowed.ts']);
    } finally {
      await pipeline.dispose();
      removeTmpDir(root);
    }
  });

  it('refreshes fallback eligibility after root files change', async () => {
    const root = createTmpFixture({
      'src/root.ts': 'export const root = 1;\n',
      'nested/src/deep.ts': 'export const deep = 1;\n',
    });
    const store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const pipeline = new IndexingPipeline(
      store,
      registry,
      TraceMcpConfigSchema.parse({ include: ['src/**/*.ts'], exclude: [] }),
      root,
    );
    try {
      expect((await pipeline.indexFiles(['nested/src/deep.ts'])).totalFiles).toBe(0);
      fs.unlinkSync(path.join(root, 'src/root.ts'));
      expect((await pipeline.indexFiles(['nested/src/deep.ts'])).indexed).toBe(1);
    } finally {
      await pipeline.dispose();
      removeTmpDir(root);
    }
  });
});
