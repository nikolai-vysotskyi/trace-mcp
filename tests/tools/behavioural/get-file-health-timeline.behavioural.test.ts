/**
 * Behavioural coverage for `getFileHealthTimeline()` in
 * `src/tools/analysis/file-health-timeline.ts` — the implementation behind
 * the `get_file_health_timeline` MCP tool. Aggregates getComplexityTrend +
 * getCouplingTrend + getChurnRate. Git is mocked via
 * `node:child_process.execFileSync` so the test runs offline.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFileHealthTimeline } from '../../../src/tools/analysis/file-health-timeline.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

const BRANCHY_SRC = `
import { a } from './a';
import { b } from './b';

export function calc(n: number): number {
  if (n < 0) return -1;
  if (n === 0) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) total += i;
    else total -= i;
  }
  return total + a + b;
}
`.trim();

/**
 * Single dispatcher covering every git invocation made by
 * getComplexityTrend, getCouplingTrend, and getChurnRate:
 *   - rev-parse: repo check
 *   - log --pretty=format:%H|%aI --follow (complexity + coupling sampling)
 *   - show <sha>:<path>: file content at commit
 *   - grep -l (coupling: importer count)
 *   - log --pretty=format:__COMMIT__...--name-only (churn)
 */
function mockGitRepoWithHistory(opts: {
  isRepo?: boolean;
  commits: Array<{ sha: string; date: string }>;
  contentForSha?: (sha: string) => string;
  importerCount?: number;
  churnAuthor?: string;
}): void {
  const isRepo = opts.isRepo !== false;
  mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') {
      if (!isRepo) throw new Error('not a git repository');
      return Buffer.from('true');
    }
    if (argList[0] === 'log') {
      const isChurnLog = argList.some(
        (a) => a.startsWith('__COMMIT__') || a.includes('__COMMIT__'),
      );
      if (isChurnLog || argList.includes('--name-only')) {
        const lines: string[] = [];
        for (const c of opts.commits) {
          lines.push(`__COMMIT__${c.sha}|${c.date}T10:00:00Z|${opts.churnAuthor ?? 'alice'}`);
          lines.push('src/x.ts');
        }
        return Buffer.from(lines.join('\n'));
      }
      // complexity/coupling sampling log
      const lines = opts.commits.map((c) => `${c.sha}|${c.date}T10:00:00Z`);
      return Buffer.from(lines.join('\n'));
    }
    if (argList[0] === 'show') {
      const ref = argList[1] ?? '';
      const sha = ref.split(':')[0];
      const content = opts.contentForSha ? opts.contentForSha(sha) : BRANCHY_SRC;
      return Buffer.from(content);
    }
    if (argList[0] === 'grep') {
      const n = opts.importerCount ?? 0;
      const lines: string[] = [];
      for (let i = 0; i < n; i++) lines.push(`fakesha:src/importer${i}.ts`);
      return Buffer.from(lines.join('\n'));
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

describe('getFileHealthTimeline() — behavioural contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns merged current + historical + churn + trend for an indexed file', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/x.ts', 'typescript', 'h1', 200);
    store.db
      .prepare(
        `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end, cyclomatic, max_nesting)
         VALUES (?, 'src/x.ts::calc#function', 'calc', 'function', 'calc', 0, 200, 1, 14, 5, 2)`,
      )
      .run(fileId);

    mockGitRepoWithHistory({
      commits: [
        { sha: 'sha1aaaaaa', date: '2026-01-19' },
        { sha: 'sha2bbbbbb', date: '2026-01-12' },
      ],
      importerCount: 2,
    });

    const result = getFileHealthTimeline(store, '/project', 'src/x.ts', { snapshots: 2 });
    expect(result).not.toBeNull();
    expect(result!.file).toBe('src/x.ts');

    expect(result!.current.max_cyclomatic).toBe(5);
    expect(typeof result!.current.ca).toBe('number');
    expect(typeof result!.current.ce).toBe('number');
    expect(typeof result!.current.instability).toBe('number');
    expect(typeof result!.current.risk_score).toBe('number');
    expect(result!.current.risk_score).toBeGreaterThanOrEqual(0);
    expect(result!.current.risk_score).toBeLessThanOrEqual(1);

    expect(Array.isArray(result!.historical)).toBe(true);
    expect(result!.historical.length).toBeGreaterThan(0);
    for (const point of result!.historical) {
      expect(typeof point.date).toBe('string');
      expect(typeof point.commit).toBe('string');
    }

    expect(result!.churn.commits).toBeGreaterThan(0);
    expect(['stable', 'active', 'volatile']).toContain(result!.churn.assessment);
    expect(['improving', 'stable', 'degrading']).toContain(result!.trend);
  });

  it('non-git directory returns null', () => {
    const store = createTestStore();
    store.insertFile('src/x.ts', 'typescript', 'h2', 200);
    mockNonGit();

    const result = getFileHealthTimeline(store, '/not-a-repo', 'src/x.ts');
    expect(result).toBeNull();
  });

  it('unknown file (not in index) returns null without throwing', () => {
    const store = createTestStore();
    mockGitRepoWithHistory({ commits: [{ sha: 'sha1aaaaaa', date: '2026-01-01' }] });

    const result = getFileHealthTimeline(store, '/project', 'src/ghost.ts');
    expect(result).toBeNull();
  });

  it('risk_score blends complexity and instability within [0, 1]', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/hot.ts', 'typescript', 'h3', 500);
    store.db
      .prepare(
        `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end, cyclomatic, max_nesting)
         VALUES (?, 'src/hot.ts::big#function', 'big', 'function', 'big', 0, 400, 1, 40, 25, 5)`,
      )
      .run(fileId);

    mockGitRepoWithHistory({
      commits: [{ sha: 'sha1aaaaaa', date: '2026-01-01' }],
      importerCount: 0, // ce > 0 (imports), ca = 0 -> instability near 1
    });

    const result = getFileHealthTimeline(store, '/project', 'src/hot.ts', { snapshots: 1 });
    expect(result).not.toBeNull();
    expect(result!.current.risk_score).not.toBeNull();
    expect(result!.current.risk_score).toBeGreaterThanOrEqual(0);
    expect(result!.current.risk_score).toBeLessThanOrEqual(1);
  });
});
