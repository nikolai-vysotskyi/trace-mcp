/**
 * Behavioural coverage for `getFileOwnership()` in
 * `src/tools/git/git-ownership.ts` (the implementation behind the
 * `get_code_owners` MCP tool). Per-file ownership via `git shortlog`.
 * `node:child_process.execFileSync` is mocked so the suite runs offline
 * and is deterministic.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFileOwnership } from '../../../src/tools/git/git-ownership.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

interface ShortlogLine {
  commits: number;
  author: string;
}

/**
 * Pretend cwd IS a git repo and reply to `git shortlog -sn --no-merges --
 * <path>` calls with the per-path lines provided in `byFile`.
 */
function mockGitWithShortlog(byFile: Record<string, ShortlogLine[]>): void {
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') return Buffer.from('true');
    if (argList[0] === 'shortlog') {
      // Path is the last positional after `--`.
      const dashIdx = argList.indexOf('--');
      const filePath = dashIdx >= 0 ? argList[dashIdx + 1] : '';
      const entries = byFile[filePath] ?? [];
      return Buffer.from(
        entries.map((e) => `${String(e.commits).padStart(6, ' ')}\t${e.author}`).join('\n'),
      );
    }
    return Buffer.from('');
  });
}

/** Force the "not a git repo" branch on every invocation. */
function mockNonGit(): void {
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') {
      throw new Error('not a git repository');
    }
    return Buffer.from('');
  });
}

describe('getFileOwnership() — behavioural contract (get_code_owners)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns per-file owners with commits + percentage from git shortlog', () => {
    mockGitWithShortlog({
      'src/a.ts': [
        { commits: 15, author: 'Alice' },
        { commits: 5, author: 'Bob' },
      ],
    });

    const results = getFileOwnership('/project', ['src/a.ts']);

    expect(results.length).toBe(1);
    const entry = results[0];
    expect(entry.file).toBe('src/a.ts');
    expect(entry.total_commits).toBe(20);
    expect(entry.owners).toEqual([
      { author: 'Alice', commits: 15, percentage: 75 },
      { author: 'Bob', commits: 5, percentage: 25 },
    ]);
  });

  it('processes multiple file_paths independently', () => {
    mockGitWithShortlog({
      'src/a.ts': [{ commits: 3, author: 'Alice' }],
      'src/b.ts': [
        { commits: 4, author: 'Bob' },
        { commits: 1, author: 'Alice' },
      ],
    });

    const results = getFileOwnership('/project', ['src/a.ts', 'src/b.ts']);
    expect(results.map((r) => r.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);

    const a = results.find((r) => r.file === 'src/a.ts')!;
    expect(a.total_commits).toBe(3);
    expect(a.owners).toEqual([{ author: 'Alice', commits: 3, percentage: 100 }]);

    const b = results.find((r) => r.file === 'src/b.ts')!;
    expect(b.total_commits).toBe(5);
    // Sort order reflects shortlog output ordering — Bob first.
    expect(b.owners[0]).toEqual({ author: 'Bob', commits: 4, percentage: 80 });
  });

  it('files with no shortlog entries are omitted from the result', () => {
    mockGitWithShortlog({
      'src/a.ts': [{ commits: 2, author: 'Alice' }],
      // 'src/b.ts' deliberately missing — git shortlog returns no lines.
    });

    const results = getFileOwnership('/project', ['src/a.ts', 'src/b.ts']);
    expect(results.length).toBe(1);
    expect(results[0].file).toBe('src/a.ts');
  });

  it('non-git directory returns an empty array', () => {
    mockNonGit();
    const results = getFileOwnership('/not-a-repo', ['src/a.ts', 'src/b.ts']);
    expect(results).toEqual([]);
  });

  it('passes the file path through `--` separator to git shortlog', () => {
    mockGitWithShortlog({
      'src/a.ts': [{ commits: 1, author: 'Alice' }],
    });

    getFileOwnership('/project', ['src/a.ts']);

    const shortlogCall = mockExecFileSync.mock.calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return args[0] === 'shortlog';
    });
    expect(shortlogCall).toBeDefined();
    const argList = (shortlogCall![1] ?? []) as string[];
    // -sn (numeric, sorted), --no-merges, then -- src/a.ts
    expect(argList).toContain('-sn');
    expect(argList).toContain('--no-merges');
    const dashIdx = argList.indexOf('--');
    expect(dashIdx).toBeGreaterThan(-1);
    expect(argList[dashIdx + 1]).toBe('src/a.ts');
  });
});
