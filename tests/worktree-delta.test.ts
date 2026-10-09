import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearWorktreeDeltaCache,
  computeWorktreeDelta,
  getWorktreeDelta,
  parseNameStatusZ,
  resolveWorktreeLink,
  WORKTREE_DELTA_CACHE_MAX,
  summarizeWorktreeDelta,
  type WorktreeDelta,
  worktreeDeltaPaths,
} from '../src/worktree-delta.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf-8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe.skipIf(process.platform === 'win32')('worktree delta', () => {
  let tmp: string;
  let main: string;
  let wt: string;

  beforeEach(() => {
    clearWorktreeDeltaCache();
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-wt-delta-')));
    main = path.join(tmp, 'main');
    wt = path.join(tmp, 'wt');
    fs.mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    write(main, '.gitignore', 'ignored.log\n');
    write(main, 'src/a.ts', 'export const a = 1;\n');
    write(main, 'src/b.ts', 'export const b = 1;\n');
    write(main, 'src/c.ts', 'export const c = 1;\n');
    write(main, 'src/old-name.ts', 'export const moved = 1;\n');
    git(main, 'add', '-A');
    git(main, 'commit', '-q', '-m', 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('resolveWorktreeLink', () => {
    it('returns null for a main checkout and a plain directory', () => {
      expect(resolveWorktreeLink(main)).toBeNull();
      const plain = path.join(tmp, 'plain');
      fs.mkdirSync(plain);
      expect(resolveWorktreeLink(plain)).toBeNull();
    });

    it('links a linked worktree to its main checkout', () => {
      expect(resolveWorktreeLink(wt)).toEqual({ worktreeRoot: wt, canonicalRoot: main });
    });

    it('resolves a session rooted in a subdirectory of the worktree to its toplevel', () => {
      fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
      expect(resolveWorktreeLink(path.join(wt, 'src'))).toEqual({
        worktreeRoot: wt,
        canonicalRoot: main,
      });
    });

    it('links a worktree nested inside its main checkout', () => {
      const nested = path.join(main, '.claude', 'worktrees', 'inner');
      git(main, 'worktree', 'add', '-q', '-b', 'inner', nested);
      expect(resolveWorktreeLink(nested)).toEqual({ worktreeRoot: nested, canonicalRoot: main });
      expect(resolveWorktreeLink(main, nested)).toEqual({
        worktreeRoot: nested,
        canonicalRoot: main,
      });
    });

    it('turns a hint naming a subdirectory into the worktree toplevel', () => {
      fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
      expect(resolveWorktreeLink(main, path.join(wt, 'src'))).toEqual({
        worktreeRoot: wt,
        canonicalRoot: main,
      });
    });

    it('ignores a hint whose worktree belongs to a different checkout', () => {
      const other = path.join(tmp, 'other');
      fs.mkdirSync(other);
      git(other, 'init', '-q', '-b', 'main');
      write(other, 'x.ts', 'export {};\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-q', '-m', 'init');
      const otherWt = path.join(tmp, 'other-wt');
      git(other, 'worktree', 'add', '-q', '-b', 'f', otherWt);
      expect(resolveWorktreeLink(main, otherWt)).toBeNull();
      expect(resolveWorktreeLink(main, path.join(tmp, 'does-not-exist'))).toBeNull();
    });

    it('honours the worktree hint a proxy forwards for a canonical session', () => {
      expect(resolveWorktreeLink(main, wt)).toEqual({ worktreeRoot: wt, canonicalRoot: main });
      // A hint naming a main checkout is not a worktree.
      expect(resolveWorktreeLink(main, main)).toBeNull();
    });
  });

  describe('computeWorktreeDelta', () => {
    it('is empty for a fresh worktree', async () => {
      const delta = await computeWorktreeDelta({ worktreeRoot: wt, canonicalRoot: main });
      expect(delta).not.toBeNull();
      expect(worktreeDeltaPaths(delta as WorktreeDelta).size).toBe(0);
      expect(delta?.worktreeHead).toBe(delta?.canonicalHead);
    });

    it('reports committed, staged and unstaged edits, deletions and untracked files', async () => {
      // committed on the branch
      write(wt, 'src/a.ts', 'export const a = 2;\n');
      git(wt, 'commit', '-q', '-am', 'edit a');
      // unstaged edit
      write(wt, 'src/b.ts', 'export const b = 2;\n');
      // deleted (unstaged)
      fs.rmSync(path.join(wt, 'src/c.ts'));
      // staged new file
      write(wt, 'src/staged.ts', 'export const s = 1;\n');
      git(wt, 'add', 'src/staged.ts');
      // rename: both sides must appear
      git(wt, 'mv', 'src/old-name.ts', 'src/new-name.ts');
      // untracked, plus an ignored file that must not appear
      write(wt, 'src/untracked.ts', 'export const u = 1;\n');
      write(wt, 'ignored.log', 'noise\n');

      const delta = (await computeWorktreeDelta({
        worktreeRoot: wt,
        canonicalRoot: main,
      })) as WorktreeDelta;

      expect(delta.modified).toEqual(['src/a.ts', 'src/b.ts', 'src/new-name.ts', 'src/staged.ts']);
      expect(delta.deleted).toEqual(['src/c.ts', 'src/old-name.ts']);
      expect(delta.untracked).toEqual(['src/untracked.ts']);
      expect(delta.worktreeHead).not.toBe(delta.canonicalHead);
    });

    it('diffs against the canonical HEAD, so files main moved on with show up', async () => {
      write(main, 'src/a.ts', 'export const a = "main moved";\n');
      git(main, 'commit', '-q', '-am', 'main advances');

      const delta = (await computeWorktreeDelta({
        worktreeRoot: wt,
        canonicalRoot: main,
      })) as WorktreeDelta;

      // The worktree still has the old a.ts while the canonical index holds the new one.
      expect(delta.modified).toEqual(['src/a.ts']);
    });

    it('resolves to null when git cannot answer', async () => {
      const notRepo = path.join(tmp, 'plain');
      fs.mkdirSync(notRepo);
      expect(await computeWorktreeDelta({ worktreeRoot: notRepo, canonicalRoot: main })).toBeNull();
    });
  });

  describe('getWorktreeDelta cache', () => {
    it('reuses a result within the TTL and recomputes after it', async () => {
      const link = { worktreeRoot: wt, canonicalRoot: main };
      const t0 = 1_000_000;
      const first = await getWorktreeDelta(link, { ttlMs: 2_000, now: t0 });
      expect(first?.modified).toEqual([]);

      write(wt, 'src/a.ts', 'export const a = 3;\n');

      const within = await getWorktreeDelta(link, { ttlMs: 2_000, now: t0 + 1_999 });
      expect(within).toBe(first);

      const after = await getWorktreeDelta(link, { ttlMs: 2_000, now: t0 + 2_000 });
      expect(after).not.toBe(first);
      expect(after?.modified).toEqual(['src/a.ts']);
    });

    it('shares one in-flight computation between concurrent callers', async () => {
      const link = { worktreeRoot: wt, canonicalRoot: main };
      const [a, b] = await Promise.all([getWorktreeDelta(link), getWorktreeDelta(link)]);
      expect(a).toBe(b);
    });

    it('evicts the entry with the oldest timestamp, not the first inserted', async () => {
      const link = (i: number) => ({
        worktreeRoot: path.join(tmp, `missing-${i}`),
        canonicalRoot: main,
      });
      const t0 = 5_000_000;
      const huge = 10_000_000;
      const first = await Promise.resolve(getWorktreeDelta(link(0), { ttlMs: huge, now: t0 }));
      expect(first).toBeNull();
      const promises: Array<ReturnType<typeof getWorktreeDelta>> = [];
      for (let i = 1; i < WORKTREE_DELTA_CACHE_MAX - 1; i++) {
        promises.push(getWorktreeDelta(link(i), { ttlMs: huge, now: t0 + i }));
      }
      await Promise.all(promises);
      // Refresh key 0 while the cache is not yet full: it keeps the first Map
      // slot but is now the newest entry.
      const later = t0 + 100_000;
      const refreshed = getWorktreeDelta(link(0), { ttlMs: 1_000, now: later });
      await refreshed;
      await getWorktreeDelta(link(WORKTREE_DELTA_CACHE_MAX - 1), { ttlMs: huge, now: later });
      // The cache is full: this insert evicts. The oldest timestamp is key 1's.
      await getWorktreeDelta(link(WORKTREE_DELTA_CACHE_MAX), { ttlMs: huge, now: later });
      expect(getWorktreeDelta(link(0), { ttlMs: huge, now: later })).toBe(refreshed);
      expect(getWorktreeDelta(link(1), { ttlMs: huge, now: later })).not.toBe(promises[0]);
    });

    it('never rejects', async () => {
      const link = { worktreeRoot: path.join(tmp, 'missing'), canonicalRoot: main };
      await expect(getWorktreeDelta(link)).resolves.toBeNull();
    });
  });

  describe('summarizeWorktreeDelta', () => {
    const delta: WorktreeDelta = {
      worktreeRoot: '/w',
      canonicalRoot: '/m',
      worktreeHead: 'a'.repeat(40),
      canonicalHead: 'b'.repeat(40),
      modified: ['x.ts', 'y.ts', 'z.ts'],
      deleted: ['gone.ts'],
      untracked: ['new.ts'],
      computedAt: 0,
    };

    it('counts every category and lists them', () => {
      const s = summarizeWorktreeDelta(delta);
      expect(s.total).toBe(5);
      expect(s.modified).toEqual(['x.ts', 'y.ts', 'z.ts']);
      expect(s.truncated).toBe(false);
    });

    it('caps long lists and says so', () => {
      const s = summarizeWorktreeDelta(delta, 2);
      expect(s.modified).toEqual(['x.ts', 'y.ts']);
      expect(s.total).toBe(5);
      expect(s.truncated).toBe(true);
    });
  });
});

describe('parseNameStatusZ', () => {
  it('splits status/path pairs and separates deletions', () => {
    expect(parseNameStatusZ('M\0a.ts\0D\0b.ts\0A\0c d.ts\0T\0e.ts\0')).toEqual({
      modified: ['a.ts', 'c d.ts', 'e.ts'],
      deleted: ['b.ts'],
    });
  });

  it('tolerates empty output', () => {
    expect(parseNameStatusZ('')).toEqual({ modified: [], deleted: [] });
  });
});
