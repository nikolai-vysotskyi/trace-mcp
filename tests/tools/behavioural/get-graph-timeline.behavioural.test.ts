/**
 * Behavioural coverage for `getGraphTimeline()` in
 * `src/tools/analysis/graph-timeline.ts` — the SIMPLIFIED first-version
 * implementation behind the `get_graph_timeline` MCP tool. Samples
 * evenly-spaced historical commits via `git log`, computes file counts via
 * `git ls-tree`, and churn via `git log --shortstat`. Git is mocked via
 * `node:child_process.execFileSync` so the test runs offline.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGraphTimeline } from '../../../src/tools/analysis/graph-timeline.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

interface CommitFixture {
  sha: string;
  iso: string;
  files: string[];
}

function mockGitTimeline(opts: { isRepo?: boolean; commits: CommitFixture[] }): void {
  const isRepo = opts.isRepo !== false;
  mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];

    if (argList[0] === 'rev-parse') {
      if (!isRepo) throw new Error('not a git repository');
      return Buffer.from('true');
    }

    if (argList[0] === 'log' && argList.includes('--shortstat')) {
      // Single whole-window call: ['log', '--since=X days ago', '--no-merges',
      // '--shortstat', '--pretty=format:__C__%H'] — one commit-tagged shortstat
      // entry per commit in the window (see getChurnByCommit), NOT per-period.
      const lines: string[] = [];
      for (const c of opts.commits) {
        lines.push(`__C__${c.sha}`);
        lines.push(` 2 files changed, 10 insertions(+), 3 deletions(-)`);
      }
      return Buffer.from(lines.join('\n'));
    }

    if (argList[0] === 'log') {
      // Plain sampling log: --pretty=format:%H|%aI
      const lines = opts.commits.map((c) => `${c.sha}|${c.iso}`);
      return Buffer.from(lines.join('\n'));
    }

    if (argList[0] === 'ls-tree') {
      // ['ls-tree', '-r', '--name-only', commitHash]
      const sha = argList[argList.length - 1];
      const commit = opts.commits.find((c) => c.sha === sha);
      return Buffer.from((commit?.files ?? []).join('\n'));
    }

    return Buffer.from('');
  });
}

function mockNonGit(): void {
  mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') throw new Error('not a git repository');
    return Buffer.from('');
  });
}

describe('getGraphTimeline() — behavioural contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('non-git directory returns null', () => {
    const store = createTestStore();
    mockNonGit();
    const result = getGraphTimeline(store, '/not-a-repo');
    expect(result).toBeNull();
  });

  it('buckets commits into monthly periods with file-count + churn narrative', () => {
    const store = createTestStore();
    store.insertFile('src/a.ts', 'typescript', 'h1', 100);

    // Fixtures are listed newest-first, matching real `git log` output order.
    mockGitTimeline({
      commits: [
        {
          sha: 'sha3cccc',
          iso: '2026-05-10T10:00:00Z',
          files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
        },
        {
          sha: 'sha2bbbb',
          iso: '2026-04-20T10:00:00Z',
          files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        },
        { sha: 'sha1aaaa', iso: '2026-04-05T10:00:00Z', files: ['src/a.ts', 'src/b.ts'] },
      ],
    });

    const result = getGraphTimeline(store, '/project', { sinceDays: 90, granularity: 'monthly' });
    expect(result).not.toBeNull();
    expect(result!.granularity).toBe('monthly');
    expect(result!._tier).toBe('simplified_commit_sampling');
    expect(result!.periods.length).toBe(2);

    const [aprilPeriod, mayPeriod] = result!.periods;
    expect(aprilPeriod.period).toBe('2026-04');
    expect(aprilPeriod.file_count).toBe(3); // newest commit in April bucket: a,b,c
    expect(mayPeriod.period).toBe('2026-05');
    expect(mayPeriod.file_count).toBe(4);
    expect(mayPeriod.narrative).toContain('files');

    // Churn is aggregated per-period from the single batched `git log
    // --shortstat` call — April bucket has 2 commits (sha1aaaa, sha2bbbb),
    // May bucket has 1 (sha3cccc); each mock commit contributes 2 files
    // changed / 10 insertions / 3 deletions.
    expect(aprilPeriod.commits_in_period).toBe(2);
    expect(aprilPeriod.insertions).toBe(20);
    expect(aprilPeriod.deletions).toBe(6);
    expect(mayPeriod.commits_in_period).toBe(1);
    expect(mayPeriod.insertions).toBe(10);
    expect(mayPeriod.deletions).toBe(3);
  });

  it('fetches churn in ONE `git log --shortstat` call for the whole window, not one per period', () => {
    const store = createTestStore();
    mockGitTimeline({
      commits: [
        { sha: 'sha4', iso: '2026-06-10T10:00:00Z', files: ['a.ts'] },
        { sha: 'sha3', iso: '2026-05-10T10:00:00Z', files: ['a.ts'] },
        { sha: 'sha2', iso: '2026-04-10T10:00:00Z', files: ['a.ts'] },
        { sha: 'sha1', iso: '2026-03-10T10:00:00Z', files: ['a.ts'] },
      ],
    });

    getGraphTimeline(store, '/project', { sinceDays: 180, granularity: 'monthly' });

    const shortstatCalls = mockExecFileSync.mock.calls.filter(([, args]) =>
      ((args ?? []) as string[]).includes('--shortstat'),
    );
    // 4 distinct monthly periods would have meant 4 separate --shortstat
    // subprocess spawns before batching; must stay at exactly 1 regardless
    // of period count.
    expect(shortstatCalls.length).toBe(1);
  });

  it('current snapshot reports live-index totals (files/symbols/edges), not historical reconstruction', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/a.ts', 'typescript', 'h1', 100);
    store.db
      .prepare(
        `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end)
         VALUES (?, 'src/a.ts::f#function', 'f', 'function', 'f', 0, 10, 1, 2)`,
      )
      .run(fileId);

    mockGitTimeline({
      commits: [{ sha: 'sha1aaaa', iso: '2026-06-01T10:00:00Z', files: ['src/a.ts'] }],
    });

    const result = getGraphTimeline(store, '/project', { sinceDays: 30 });
    expect(result).not.toBeNull();
    expect(result!.current.files).toBe(1);
    expect(result!.current.symbols).toBe(1);
    expect(typeof result!.current.edges_by_type).toBe('object');
  });

  it('max_periods caps the number of returned periods to the most recent', () => {
    const store = createTestStore();
    mockGitTimeline({
      commits: [
        { sha: 'sha1', iso: '2026-01-05T10:00:00Z', files: ['a.ts'] },
        { sha: 'sha2', iso: '2026-02-05T10:00:00Z', files: ['a.ts', 'b.ts'] },
        { sha: 'sha3', iso: '2026-03-05T10:00:00Z', files: ['a.ts', 'b.ts', 'c.ts'] },
      ],
    });

    const result = getGraphTimeline(store, '/project', {
      sinceDays: 200,
      granularity: 'monthly',
      maxPeriods: 2,
    });
    expect(result).not.toBeNull();
    expect(result!.periods.length).toBe(2);
    // Most recent periods kept.
    expect(result!.periods[result!.periods.length - 1].period).toBe('2026-03');
  });

  it('methodology envelope discloses the simplified tier and its limitations', () => {
    const store = createTestStore();
    mockGitTimeline({ commits: [{ sha: 'sha1', iso: '2026-01-05T10:00:00Z', files: ['a.ts'] }] });

    const result = getGraphTimeline(store, '/project');
    expect(result).not.toBeNull();
    expect(result!._methodology.description).toBeTruthy();
    expect(result!._methodology.limitations.length).toBeGreaterThan(0);
  });
});
