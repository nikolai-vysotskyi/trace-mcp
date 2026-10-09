/**
 * Results about files a linked worktree changed are flagged `stale_on_branch`
 * (GH #1481). Two layers:
 *
 *  1. `markStaleOnBranch` / `staleOnBranchWarning` on plain objects.
 *  2. A real MCP server over an in-memory transport: a session rooted at a
 *     linked worktree flags `search`/`get_outline`/`batch` results and reports
 *     the delta in `get_index_health`; the same calls in a main checkout come
 *     back without any trace of the feature.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { ProgressState } from '../../src/progress.js';
import { createServer } from '../../src/server/server.js';
import { markStaleOnBranch, staleOnBranchWarning } from '../../src/server/worktree-stale.js';
import { clearWorktreeDeltaCache, type WorktreeDelta } from '../../src/worktree-delta.js';

const delta = (over: Partial<WorktreeDelta> = {}): WorktreeDelta => ({
  worktreeRoot: '/wt',
  canonicalRoot: '/main',
  worktreeHead: 'a'.repeat(40),
  canonicalHead: 'b'.repeat(40),
  modified: ['src/a.ts'],
  deleted: ['src/gone.ts'],
  untracked: ['src/new.ts'],
  computedAt: 0,
  ...over,
});

describe('markStaleOnBranch', () => {
  it('flags objects whose own path field names a delta file', () => {
    const payload = {
      items: [
        { file: 'src/a.ts', name: 'alpha' },
        { file: 'src/b.ts', name: 'beta' },
        { path: 'src/gone.ts' },
        { file_path: 'src/new.ts' },
        { filePath: 'src/a.ts' },
      ],
    };
    const files = markStaleOnBranch(payload, delta());
    expect(files).toEqual(['src/a.ts', 'src/gone.ts', 'src/new.ts']);
    expect(payload.items.map((i) => (i as { stale_on_branch?: boolean }).stale_on_branch)).toEqual([
      true,
      undefined,
      true,
      true,
      true,
    ]);
  });

  it('matches absolute and ./-prefixed spellings under either root', () => {
    const payload = [
      { file: '/wt/src/a.ts' },
      { file: '/main/src/a.ts' },
      { file: './src/a.ts' },
      { file: '/elsewhere/src/a.ts' },
    ];
    markStaleOnBranch(payload, delta());
    expect(payload.map((i) => (i as { stale_on_branch?: boolean }).stale_on_branch)).toEqual([
      true,
      true,
      true,
      undefined,
    ]);
  });

  it('reports files listed as bare strings without trying to flag them', () => {
    const payload = { affected_files: ['src/a.ts', 'src/b.ts'], other: ['src/gone.ts'] };
    expect(markStaleOnBranch(payload, delta())).toEqual(['src/a.ts']);
    expect(payload).not.toHaveProperty('stale_on_branch');
  });

  it('reads camelCase list keys too', () => {
    const payload = { changedFiles: ['src/a.ts'], filePaths: ['src/gone.ts'] };
    expect(markStaleOnBranch(payload, delta())).toEqual(['src/a.ts', 'src/gone.ts']);
  });

  it('does nothing for an empty delta or an unrelated payload', () => {
    const payload = { file: 'src/a.ts' };
    expect(markStaleOnBranch(payload, delta({ modified: [], deleted: [], untracked: [] }))).toEqual(
      [],
    );
    expect(payload).toEqual({ file: 'src/a.ts' });
    const other = { file: 'src/other.ts', n: 1 };
    expect(markStaleOnBranch(other, delta())).toEqual([]);
    expect(other).toEqual({ file: 'src/other.ts', n: 1 });
  });
});

describe('staleOnBranchWarning', () => {
  it('is null without files and names a few with a count otherwise', () => {
    expect(staleOnBranchWarning([])).toBeNull();
    const w = staleOnBranchWarning(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']);
    expect(w).toContain('7 file(s)');
    expect(w).toContain('a.ts, b.ts, c.ts, d.ts, e.ts');
    expect(w).toContain('(+2 more)');
    expect(w).toContain('stale_on_branch');
  });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf-8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

type Json = Record<string, unknown>;

describe.skipIf(process.platform === 'win32')('worktree session over MCP', () => {
  let tmp: string;
  let main: string;
  let wt: string;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeEach(() => {
    clearWorktreeDeltaCache();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-wt-stale-')));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(main, 'src'), { recursive: true });
    git(main, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(main, 'src/a.ts'), 'export function alpha() {}\n');
    fs.writeFileSync(path.join(main, 'src/b.ts'), 'export function beta() {}\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
    // The branch changes a.ts only.
    fs.writeFileSync(path.join(wt, 'src/a.ts'), 'export function alpha() { return 1; }\n');
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Boot a server rooted at `root` over an index that knows a.ts and b.ts. */
  async function connect(root: string, deps: Parameters<typeof createServer>[5] = {}) {
    const db = initializeDatabase(':memory:');
    const store = new Store(db);
    for (const [file, name] of [
      ['src/a.ts', 'alpha'],
      ['src/b.ts', 'beta'],
    ] as const) {
      const fid = store.insertFile(file, 'typescript', `h-${name}`, 100);
      store.insertSymbol(fid, {
        symbolId: `${file}::${name}#function`,
        name,
        kind: 'function',
        fqn: name,
        byteStart: 0,
        byteEnd: 26,
        lineStart: 1,
        lineEnd: 1,
      });
    }
    const config = TraceMcpConfigSchema.parse({ tools: { preset: 'full' } });
    const handle = createServer(
      store,
      PluginRegistry.createWithDefaults(),
      config,
      root,
      new ProgressState(db),
      deps,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'worktree-probe', version: '1.0.0' });
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(async () => {
      await client.close().catch(() => {});
      handle.dispose();
      db.close();
    });
    const call = async (name: string, args: Json = {}): Promise<{ text: string; json: Json }> => {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ type: string; text: string }>;
      };
      const text = res.content[0].text;
      return { text, json: JSON.parse(text) as Json };
    };
    return { call };
  }

  const flaggedFiles = (value: unknown, out: string[] = []): string[] => {
    if (Array.isArray(value)) for (const v of value) flaggedFiles(v, out);
    else if (value && typeof value === 'object') {
      const o = value as Json;
      if (o.stale_on_branch === true) out.push(String(o.file ?? o.path ?? o.file_path));
      for (const v of Object.values(o)) flaggedFiles(v, out);
    }
    return out;
  };

  it('flags get_outline for a changed file and leaves an unchanged one alone', async () => {
    const { call } = await connect(wt);
    const changed = await call('get_outline', { path: 'src/a.ts' });
    expect(flaggedFiles(changed.json)).toContain('src/a.ts');
    expect(JSON.stringify(changed.json._warnings)).toContain('src/a.ts');

    const unchanged = await call('get_outline', { path: 'src/b.ts' });
    expect(flaggedFiles(unchanged.json)).toEqual([]);
    expect(unchanged.text).not.toContain('stale_on_branch');
    expect(unchanged.text).not.toContain('Worktree:');
  });

  it('flags search results by their file', async () => {
    const { call } = await connect(wt);
    const res = await call('search', { query: 'alpha' });
    expect(res.text).toContain('src/a.ts');
    expect(flaggedFiles(res.json)).toContain('src/a.ts');
  });

  it('flags results dispatched through batch', async () => {
    const { call } = await connect(wt);
    const res = await call('batch', {
      calls: [
        { tool: 'get_outline', args: { path: 'src/a.ts' } },
        { tool: 'get_outline', args: { path: 'src/b.ts' } },
      ],
    });
    const results = res.json.batch_results as Array<{ result: Json }>;
    expect(flaggedFiles(results[0].result)).toContain('src/a.ts');
    expect(flaggedFiles(results[1].result)).toEqual([]);
  });

  it('reports the delta in get_index_health', async () => {
    const { call } = await connect(wt);
    const { json } = await call('get_index_health');
    const worktree = json.worktree as Json;
    expect(worktree.is_linked_worktree).toBe(true);
    expect(worktree.worktree_root).toBe(wt);
    expect(worktree.canonical_root).toBe(main);
    expect(worktree.modified).toEqual(['src/a.ts']);
    expect(worktree.total).toBe(1);
  });

  it('resolves a session rooted in a worktree subdirectory', async () => {
    fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
    const { call } = await connect(path.join(wt, 'src'));
    const { json } = await call('get_index_health');
    expect((json.worktree as Json).worktree_root).toBe(wt);
  });

  it('ignores a forwarded hint that does not belong to the session root', async () => {
    const { call } = await connect(path.join(tmp), { worktreeRoot: wt });
    const { json } = await call('get_index_health');
    expect(json).not.toHaveProperty('worktree');
  });

  it('serves a canonical session routed from a worktree via the forwarded hint', async () => {
    const { call } = await connect(main, { worktreeRoot: wt });
    const { json } = await call('get_index_health');
    expect((json.worktree as Json).modified).toEqual(['src/a.ts']);
    const outline = await call('get_outline', { path: 'src/a.ts' });
    expect(flaggedFiles(outline.json)).toContain('src/a.ts');
  });

  it('changes nothing in a main checkout', async () => {
    // Same working-tree edit in main: no worktree, so no delta and no marks.
    fs.writeFileSync(path.join(main, 'src/a.ts'), 'export function alpha() { return 2; }\n');
    const { call } = await connect(main);
    const health = await call('get_index_health');
    expect(health.json).not.toHaveProperty('worktree');

    for (const [tool, args] of [
      ['get_outline', { path: 'src/a.ts' }],
      ['search', { query: 'alpha' }],
    ] as const) {
      const res = await call(tool, args);
      expect(res.text).not.toContain('stale_on_branch');
      expect(res.text).not.toContain('Worktree:');
    }
    const batch = await call('batch', {
      calls: [{ tool: 'get_outline', args: { path: 'src/a.ts' } }],
    });
    expect(batch.text).not.toContain('stale_on_branch');
  });
});
