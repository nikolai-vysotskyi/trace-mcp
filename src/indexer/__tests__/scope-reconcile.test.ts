/**
 * TRA-468 — a full reindex used to be purely additive. `insertFile` upserts
 * and nothing ever deleted, so every path any past version once walked stayed
 * in `files` / `symbols` and in search results forever, even after the walker
 * stopped visiting it. One real project carried 1650 rows from May–July under a
 * `lastIndexed` stamp from a run that wrote 183 of them; 93% of its symbols
 * came from git-ignored vendored trees the current indexer walks right past.
 *
 * Two halves, tested here:
 *   - `selectOutOfScopeFiles` — which rows a full walk may delete;
 *   - end to end — a poisoned index converges on the next `indexAll`, and
 *     git-ignored files never enter it in the first place.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { TraceMcpConfigSchema } from '../../config.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { TypeScriptLanguagePlugin } from '../plugins/language/typescript/index.js';
import { IndexingPipeline, selectOutOfScopeFiles } from '../pipeline.js';

function row(over: Partial<Parameters<typeof selectOutOfScopeFiles>[0]['files'][0]> = {}) {
  return {
    id: 1,
    path: 'src/a.ts',
    language: 'typescript',
    content_hash: 'h1',
    ...over,
  };
}

describe('selectOutOfScopeFiles', () => {
  it('drops rows the current walk no longer owns', () => {
    const files = [row({ id: 1, path: 'src/a.ts' }), row({ id: 2, path: 'vendored/b.ts' })];
    expect(selectOutOfScopeFiles({ files, inScope: ['src/a.ts'], truncated: false })).toEqual([2]);
  });

  it('keeps every row the walk still owns', () => {
    const files = [row({ id: 1, path: 'src/a.ts' }), row({ id: 2, path: 'src/b.ts' })];
    expect(
      selectOutOfScopeFiles({ files, inScope: ['src/a.ts', 'src/b.ts'], truncated: false }),
    ).toEqual([]);
  });

  it('keeps phantom rows for external packages — they have no path on disk', () => {
    const files = [
      row({ id: 2, path: 'node_modules/lodash/index.js', content_hash: '__phantom__' }),
      row({ id: 3, path: 'react', content_hash: '__phantom_pkg__' }),
    ];
    expect(selectOutOfScopeFiles({ files, inScope: ['src/a.ts'], truncated: false })).toEqual([]);
  });

  it('keeps .env rows — EnvIndexer writes those on a separate pass', () => {
    const files = [row({ id: 2, path: '.env.local', language: 'env' })];
    expect(selectOutOfScopeFiles({ files, inScope: ['src/a.ts'], truncated: false })).toEqual([]);
  });

  it('refuses to act on an empty walk (glob failure must not wipe the index)', () => {
    const files = [row({ id: 1 }), row({ id: 2, path: 'src/b.ts' })];
    expect(selectOutOfScopeFiles({ files, inScope: [], truncated: false })).toEqual([]);
  });

  it('refuses to act on a truncated walk — "not in scope" only means "past the cap"', () => {
    const files = [row({ id: 1 }), row({ id: 2, path: 'src/b.ts' })];
    expect(selectOutOfScopeFiles({ files, inScope: ['src/a.ts'], truncated: true })).toEqual([]);
  });

  it('prunes only confirmed missing files on a truncated walk', () => {
    const files = [
      row({ id: 1, path: 'src/a.ts' }),
      row({ id: 2, path: 'src/deleted.ts' }),
      row({ id: 3, path: 'src/past-cap.ts' }),
      row({ id: 4, path: '.env.local', language: 'env' }),
      row({ id: 5, path: 'react', content_hash: '__phantom_pkg__' }),
    ];
    const checked: string[] = [];
    expect(
      selectOutOfScopeFiles({
        files,
        inScope: ['src/a.ts'],
        truncated: true,
        fileExists: (p) => {
          checked.push(p);
          return p === 'src/past-cap.ts';
        },
      }),
    ).toEqual([2]);
    expect(checked).toEqual(['src/deleted.ts', 'src/past-cap.ts']);
  });
});

describe('indexAll — scope reconcile and .gitignore (end to end)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'scope-reconcile-'));
    mkdirSync(join(workDir, 'src'), { recursive: true });
    mkdirSync(join(workDir, 'vendored', 'deep'), { recursive: true });
    writeFileSync(join(workDir, '.gitignore'), 'vendored/\n');
    writeFileSync(join(workDir, 'src', 'a.ts'), 'export function realOne() { return 1; }\n');
    writeFileSync(join(workDir, 'vendored', 'b.ts'), 'export function ghostOne() { return 2; }\n');
    writeFileSync(
      join(workDir, 'vendored', 'deep', 'c.ts'),
      'export function ghostTwo() { return 3; }\n',
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function makePipeline(store: Store, maxFiles?: number) {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = TraceMcpConfigSchema.parse({
      root: workDir,
      include: ['**/*.ts'],
      exclude: [],
      security: maxFiles === undefined ? undefined : { max_files: maxFiles },
    });
    return new IndexingPipeline(store, registry, config, workDir);
  }

  it('never indexes git-ignored files', async () => {
    const store = new Store(initializeDatabase(':memory:'));
    await makePipeline(store).indexAll();

    const paths = store.getAllFiles().map((f) => f.path);
    expect(paths).toContain('src/a.ts');
    expect(paths).not.toContain('vendored/b.ts');
    expect(paths).not.toContain('vendored/deep/c.ts');
  });

  it('deletes rows a previous version left behind for out-of-scope files', async () => {
    const store = new Store(initializeDatabase(':memory:'));

    // Stand in for what an older indexer wrote: a vendored tree that the
    // current walk excludes, plus a file since deleted from disk.
    const stale = store.insertFile('vendored/b.ts', 'typescript', 'old', 40, null, null);
    store.insertSymbol(stale, {
      symbolId: 'vendored/b.ts::ghostOne#function',
      name: 'ghostOne',
      kind: 'function',
      byteStart: 0,
      byteEnd: 10,
      lineStart: 1,
      lineEnd: 1,
    });
    store.insertFile('src/gone.ts', 'typescript', 'old', 40, null, null);
    expect(store.getAllFiles()).toHaveLength(2);

    await makePipeline(store).indexAll();

    const paths = store.getAllFiles().map((f) => f.path);
    expect(paths).toEqual(['src/a.ts']);
    // The stale row's symbols went with it — they are what search was serving.
    const names = store
      .getAllFiles()
      .flatMap((f) => store.getSymbolsByFile(f.id).map((s) => s.name));
    expect(names).toEqual(['realOne']);
  });

  it('prunes deleted rows after a truncated walk but preserves files past the cap', async () => {
    const store = new Store(initializeDatabase(':memory:'));
    writeFileSync(join(workDir, 'src', 'z.ts'), 'export const stillHere = 1;\n');
    const deletedId = store.insertFile('src/deleted.ts', 'typescript', 'old', 10, null, null);
    store.insertSymbol(deletedId, {
      symbolId: 'src/deleted.ts::stale#function',
      name: 'stale',
      kind: 'function',
      byteStart: 0,
      byteEnd: 5,
      lineStart: 1,
      lineEnd: 1,
    });
    store.insertFile('src/z.ts', 'typescript', 'old', 10, null, null);

    await makePipeline(store, 1).indexAll();

    const paths = store.getAllFiles().map((f) => f.path);
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/z.ts');
    expect(paths).not.toContain('src/deleted.ts');
    expect(store.getSymbolsByFile(deletedId)).toEqual([]);
  });

  it('deletes every indexed file beneath a deleted directory event', () => {
    const store = new Store(initializeDatabase(':memory:'));
    const pipeline = makePipeline(store);
    const file = store.insertFile('top100/old/a.ts', 'typescript', 'old', 10, null, null);
    store.insertSymbol(file, {
      symbolId: 'top100/old/a.ts::ghost#function',
      name: 'ghost',
      kind: 'function',
      byteStart: 0,
      byteEnd: 5,
      lineStart: 1,
      lineEnd: 1,
    });
    store.insertFile('top100/old/deep/b.ts', 'typescript', 'old', 10, null, null);
    store.insertFile('top100/older/c.ts', 'typescript', 'old', 10, null, null);

    pipeline.deleteFiles([join(workDir, 'top100', 'old')]);

    expect(store.getAllFiles().map((f) => f.path)).toEqual(['top100/older/c.ts']);
    expect(store.getSymbolsByFile(file)).toEqual([]);
  });

  it('evicts descendants when a directory is replaced by a regular file', () => {
    const store = new Store(initializeDatabase(':memory:'));
    const pipeline = makePipeline(store);
    store.insertFile('top100/old/a.ts', 'typescript', 'old', 10, null, null);
    mkdirSync(join(workDir, 'top100'));
    writeFileSync(join(workDir, 'top100', 'old'), 'replacement');

    pipeline.deleteFiles(['top100/old']);

    expect(store.getAllFiles()).toEqual([]);
  });

  it('handles paths with trailing and repeated slashes safely without polynomial regex slowdown', () => {
    const store = new Store(initializeDatabase(':memory:'));
    store.insertFile('top100/old/a.ts', 'typescript', 'old', 10, null, null);
    store.insertFile('top100/old/deep/b.ts', 'typescript', 'old', 10, null, null);
    store.insertFile('top100/older/c.ts', 'typescript', 'old', 10, null, null);

    const pathWithRepeatedSlashes = `top100/old${'/'.repeat(2000)}`;
    const files = store.getFilesUnderPath(pathWithRepeatedSlashes);

    expect(files.map((f) => f.path)).toEqual(['top100/old/a.ts', 'top100/old/deep/b.ts']);
  });
});
