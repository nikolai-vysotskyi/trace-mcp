/**
 * Behavioural coverage for `getChurnRate()` in
 * `src/tools/git/git-analysis.ts` (the implementation behind the
 * `get_git_churn` MCP tool). Per-file commit count, author count, and
 * volatility assessment. Git is mocked via `node:child_process.execFileSync`
 * so the test runs offline and is deterministic.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getChurnRate } from '../../../src/tools/git/git-analysis.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

interface GitCommit {
  file: string;
  date: string; // ISO timestamp
  author: string;
}

/**
 * Pretend cwd IS a git repo and replay the supplied commit stream when
 * `git log --pretty=format:__COMMIT__... --name-only ...` is invoked.
 */
function mockGitRepoWithCommits(commits: GitCommit[]): void {
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') return Buffer.from('true');
    if (argList[0] === 'log') {
      const lines: string[] = [];
      let counter = 0;
      for (const c of commits) {
        counter++;
        lines.push(`__COMMIT__sha${counter}|${c.date}|${c.author}`);
        lines.push(c.file);
      }
      return Buffer.from(lines.join('\n'));
    }
    return Buffer.from('');
  });
}

/** Force the "not a git repo" branch. */
function mockNonGit(): void {
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') {
      const err = new Error('not a git repository');
      throw err;
    }
    return Buffer.from('');
  });
}

describe('getChurnRate() — behavioural contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns per-file commits + unique_authors + churn_per_week + assessment', () => {
    mockGitRepoWithCommits([
      { file: 'src/hot.ts', date: '2026-01-05T10:00:00Z', author: 'Alice' },
      { file: 'src/hot.ts', date: '2026-01-12T10:00:00Z', author: 'Bob' },
      { file: 'src/hot.ts', date: '2026-01-19T10:00:00Z', author: 'Alice' },
      { file: 'src/cold.ts', date: '2026-01-05T10:00:00Z', author: 'Alice' },
    ]);

    const results = getChurnRate('/project');
    const hot = results.find((r) => r.file === 'src/hot.ts');
    expect(hot).toBeDefined();
    expect(hot!.commits).toBe(3);
    expect(hot!.unique_authors).toBe(2);
    expect(typeof hot!.churn_per_week).toBe('number');
    expect(['stable', 'active', 'volatile']).toContain(hot!.assessment);
    expect(hot!.first_seen).toBe('2026-01-05');
    expect(hot!.last_modified).toBe('2026-01-19');
  });

  it('sinceDays window is propagated to git log as --since', () => {
    mockGitRepoWithCommits([{ file: 'src/a.ts', date: '2026-01-05T10:00:00Z', author: 'Alice' }]);
    getChurnRate('/project', { sinceDays: 30 });

    const logCall = mockExecFileSync.mock.calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return args[0] === 'log';
    });
    expect(logCall).toBeDefined();
    const argList = (logCall![1] ?? []) as string[];
    expect(argList.some((a) => /^--since=30 days ago$/.test(a))).toBe(true);
  });

  it('file_pattern filter narrows results to matching paths', () => {
    mockGitRepoWithCommits([
      { file: 'src/tools/x.ts', date: '2026-01-05T10:00:00Z', author: 'Alice' },
      { file: 'src/tools/x.ts', date: '2026-01-12T10:00:00Z', author: 'Alice' },
      { file: 'tests/x.test.ts', date: '2026-01-05T10:00:00Z', author: 'Alice' },
    ]);

    const results = getChurnRate('/project', { filePattern: 'src/tools/' });
    expect(results.map((r) => r.file)).toEqual(['src/tools/x.ts']);
  });

  it('limit caps the number of returned churn rows', () => {
    const commits: GitCommit[] = [];
    for (let i = 0; i < 5; i++) {
      for (let n = 0; n < 5 - i; n++) {
        commits.push({
          file: `src/f${i}.ts`,
          date: `2026-01-${String(n + 1).padStart(2, '0')}T10:00:00Z`,
          author: 'Alice',
        });
      }
    }
    mockGitRepoWithCommits(commits);

    const results = getChurnRate('/project', { limit: 2 });
    expect(results.length).toBe(2);
    // Sorted by commits desc → f0 (5 commits) and f1 (4 commits).
    expect(results[0].file).toBe('src/f0.ts');
    expect(results[1].file).toBe('src/f1.ts');
  });

  it('non-git directory returns an empty array (per methodology disclosure)', () => {
    mockNonGit();
    const results = getChurnRate('/not-a-repo');
    expect(results).toEqual([]);
  });
});
