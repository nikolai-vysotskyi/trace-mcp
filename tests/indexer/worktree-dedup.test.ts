/**
 * Umbrella root holding a repo plus a linked worktree of it: the worktree
 * contributes only the files that differ from the main checkout, both on the
 * full walk and on watcher/hook batches.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { _resetNestedWorktreeCache } from '../../src/registry.js';
import { _resetWorktreePlanCache } from '../../src/indexer/worktree-dedup.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'pipe',
  });

let umbrella: string;

beforeEach(() => {
  umbrella = mkdtempSync(join(tmpdir(), 'trace-wt-dedup-'));
  const repo = join(umbrella, 'biz', 'app');
  mkdirSync(repo, { recursive: true });
  for (const f of ['a', 'b', 'c']) writeFileSync(join(repo, `${f}.ts`), `export const ${f} = 1;\n`);
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat', join(umbrella, 'biz', 'app-feat'));
  const wt = join(umbrella, 'biz', 'app-feat');
  writeFileSync(join(wt, 'b.ts'), 'export const b = 2;\n');
  writeFileSync(join(wt, 'd.ts'), 'export const d = 1;\n');
  _resetNestedWorktreeCache();
  _resetWorktreePlanCache();
});

afterEach(() => {
  rmSync(umbrella, { recursive: true, force: true });
});

function pipeline() {
  const store = new Store(initializeDatabase(':memory:'));
  const plugins = new PluginRegistry();
  plugins.registerLanguagePlugin(new TypeScriptLanguagePlugin());
  const config = {
    include: ['**/*.ts'],
    exclude: ['node_modules/**'],
    ignore: { use_gitignore: true, additional_patterns: [] },
  } as unknown as TraceMcpConfig;
  return { store, p: new IndexingPipeline(store, plugins, config, umbrella) };
}

const paths = (store: Store) =>
  store
    .getAllFiles()
    .map((f) => f.path)
    .filter((p) => !p.startsWith('__'))
    .sort();

describe('nested worktree dedup', () => {
  it('full walk indexes the main checkout plus only the worktree delta', async () => {
    const { store, p } = pipeline();
    await p.indexAll(true);
    expect(paths(store)).toEqual([
      'biz/app-feat/b.ts',
      'biz/app-feat/d.ts',
      'biz/app/a.ts',
      'biz/app/b.ts',
      'biz/app/c.ts',
    ]);
  });

  it('incremental batches skip identical worktree files and pick up new edits', async () => {
    const { store, p } = pipeline();
    await p.indexAll(true);
    const unchanged = join(umbrella, 'biz', 'app-feat', 'c.ts');

    const skipped = await p.indexFiles([unchanged]);
    expect(skipped.indexed).toBe(0);
    expect(paths(store)).not.toContain('biz/app-feat/c.ts');

    writeFileSync(unchanged, 'export const c = 42;\n');
    const edited = await p.indexFiles([unchanged]);
    expect(edited.indexed).toBe(1);
    expect(paths(store)).toContain('biz/app-feat/c.ts');
  });

  it('sibling worktrees on a branch far from the main checkout share one copy', async () => {
    // Main checkout stays on the old line; two task worktrees branch from a
    // new line where every file differs from main — the umbrella layout that
    // made a main-only delta useless.
    const repo = join(umbrella, 'biz', 'app');
    git(repo, 'checkout', '-q', '-b', 'v3');
    for (const f of ['a', 'b', 'c'])
      writeFileSync(join(repo, `${f}.ts`), `export const ${f} = 3;\n`);
    git(repo, 'commit', '-qam', 'v3');
    git(repo, 'worktree', 'add', '-q', '-b', 't1', join(umbrella, 'biz', 'v3-t1'), 'v3');
    git(repo, 'worktree', 'add', '-q', '-b', 't2', join(umbrella, 'biz', 'v3-t2'), 'v3');
    git(repo, 'checkout', '-q', '-');
    writeFileSync(join(umbrella, 'biz', 'v3-t2', 'a.ts'), 'export const a = 4;\n');
    _resetNestedWorktreeCache();
    _resetWorktreePlanCache();

    const { store, p } = pipeline();
    await p.indexAll(true);
    const indexed = paths(store);
    expect(indexed.filter((x) => x.startsWith('biz/v3-t1/'))).toEqual([
      'biz/v3-t1/a.ts',
      'biz/v3-t1/b.ts',
      'biz/v3-t1/c.ts',
    ]);
    expect(indexed.filter((x) => x.startsWith('biz/v3-t2/'))).toEqual(['biz/v3-t2/a.ts']);
  });

  it('a committed (clean) change the cached plan predates is re-planned and indexed', async () => {
    const { store, p } = pipeline();
    await p.indexAll(true);
    const wt = join(umbrella, 'biz', 'app-feat');
    writeFileSync(join(wt, 'c.ts'), 'export const c = 7;\n');
    git(wt, 'commit', '-qam', 'c on feat');

    const r = await p.indexFiles([join(wt, 'c.ts')]);
    expect(r.indexed).toBe(1);
    expect(paths(store)).toContain('biz/app-feat/c.ts');
  });
});
