/**
 * Behavioural coverage for `getComplexityTrend()` in
 * `src/tools/analysis/complexity-trend.ts` (the implementation behind the
 * `get_complexity_trend` MCP tool). Git is mocked via
 * `node:child_process.execFileSync` so the test runs offline and is
 * deterministic.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getComplexityTrend } from '../../../src/tools/analysis/complexity-trend.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

/**
 * Pretend cwd IS a git repo. `git log` replays the supplied commit list,
 * `git show <sha>:<path>` returns synthetic file content with branchy logic
 * so cyclomatic complexity is non-trivial.
 */
function mockGitRepoWithHistory(
  commits: Array<{ sha: string; date: string }>,
  contentForSha: (sha: string) => string,
): void {
  mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') return Buffer.from('true');
    if (argList[0] === 'log') {
      const lines = commits.map((c) => `${c.sha}|${c.date}T10:00:00Z`);
      return Buffer.from(lines.join('\n'));
    }
    if (argList[0] === 'show') {
      // argList[1] is e.g. `sha1:src/x.ts`
      const ref = argList[1] ?? '';
      const sha = ref.split(':')[0];
      return Buffer.from(contentForSha(sha));
    }
    return Buffer.from('');
  });
}

function mockNonGit(): void {
  mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') {
      throw new Error('not a git repository');
    }
    return Buffer.from('');
  });
}

const BRANCHY_SRC = `
export function calc(n: number): number {
  if (n < 0) return -1;
  if (n === 0) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) total += i;
    else total -= i;
  }
  return total;
}
`.trim();

describe('getComplexityTrend() — behavioural contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { file, current, historical, trend, delta } with snapshots count respected', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/x.ts', 'typescript', 'h1', 200);
    // Seed at least one symbol with complexity so the "current" snapshot can be built.
    store.db
      .prepare(
        `UPDATE files SET id = id WHERE id = ?`, // noop to satisfy stmt
      )
      .run(fileId);
    store.db
      .prepare(
        `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end, cyclomatic, max_nesting)
         VALUES (?, 'src/x.ts::calc#function', 'calc', 'function', 'calc', 0, 80, 1, 10, 5, 2)`,
      )
      .run(fileId);

    mockGitRepoWithHistory(
      [
        { sha: 'sha1aaaaaa', date: '2026-01-19' },
        { sha: 'sha2bbbbbb', date: '2026-01-12' },
        { sha: 'sha3cccccc', date: '2026-01-05' },
      ],
      () => BRANCHY_SRC,
    );

    const result = getComplexityTrend(store, '/project', 'src/x.ts', { snapshots: 3 });
    expect(result).not.toBeNull();
    expect(result!.file).toBe('src/x.ts');
    expect(result!.current).toBeDefined();
    expect(result!.current.commit).toBe('HEAD');
    expect(Array.isArray(result!.historical)).toBe(true);
    // Snapshot cap honoured (we asked for 3; mock returned 3).
    expect(result!.historical.length).toBeLessThanOrEqual(3);
    expect(['improving', 'stable', 'degrading']).toContain(result!.trend);
    expect(typeof result!.delta).toBe('number');
  });

  it('each historical snapshot carries the expected metric fields', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/y.ts', 'typescript', 'h2', 200);
    store.db
      .prepare(
        `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end, cyclomatic, max_nesting)
         VALUES (?, 'src/y.ts::g#function', 'g', 'function', 'g', 0, 80, 1, 10, 3, 1)`,
      )
      .run(fileId);

    mockGitRepoWithHistory([{ sha: 'sha1aaaaaa', date: '2026-02-01' }], () => BRANCHY_SRC);

    const result = getComplexityTrend(store, '/project', 'src/y.ts', { snapshots: 1 });
    expect(result).not.toBeNull();
    expect(result!.historical.length).toBeGreaterThan(0);
    const snap = result!.historical[0];
    expect(typeof snap.date).toBe('string');
    expect(typeof snap.commit).toBe('string');
    expect(typeof snap.max_cyclomatic).toBe('number');
    expect(typeof snap.avg_cyclomatic).toBe('number');
    expect(typeof snap.max_nesting).toBe('number');
    expect(typeof snap.functions_counted).toBe('number');
  });

  it('non-git directory returns null', () => {
    const store = createTestStore();
    store.insertFile('src/x.ts', 'typescript', 'h3', 200);
    mockNonGit();

    const result = getComplexityTrend(store, '/not-a-repo', 'src/x.ts');
    expect(result).toBeNull();
  });

  it('unknown file (not in index) returns null without throwing', () => {
    const store = createTestStore();
    mockGitRepoWithHistory([{ sha: 'sha1aaaaaa', date: '2026-01-01' }], () => BRANCHY_SRC);

    // No insertFile/insertSymbol — file is unknown to the index.
    const result = getComplexityTrend(store, '/project', 'src/ghost.ts');
    expect(result).toBeNull();
  });

  it('file in index but zero complexity-bearing symbols returns null (no current snapshot)', () => {
    const store = createTestStore();
    store.insertFile('src/empty.ts', 'typescript', 'h4', 50);
    // No symbols inserted.
    mockGitRepoWithHistory([{ sha: 'sha1aaaaaa', date: '2026-01-01' }], () => BRANCHY_SRC);

    const result = getComplexityTrend(store, '/project', 'src/empty.ts');
    expect(result).toBeNull();
  });
});
