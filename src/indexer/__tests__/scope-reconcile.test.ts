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

  function makePipeline(store: Store) {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    const config = TraceMcpConfigSchema.parse({
      root: workDir,
      include: ['**/*.ts'],
      exclude: [],
      db: { path: ':memory:' },
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
});
