/**
 * Behavioural coverage for `getCouplingTrend()` in
 * `src/tools/analysis/history.ts` (the implementation behind the
 * `get_coupling_trend` MCP tool). Git is mocked via
 * `node:child_process.execFileSync`.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCouplingTrend } from '../../../src/tools/analysis/history.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

const SAMPLE_SRC = `
import { a } from './a';
import { b } from './b';
import { c } from './c';

export function f() { return a + b + c; }
`.trim();

/** All git invocations route through this dispatcher. */
function mockGit(opts: {
  isRepo?: boolean;
  logCommits?: Array<{ sha: string; date: string }>;
  contentForSha?: (sha: string) => string;
  importerCount?: number;
}): void {
  const isRepo = opts.isRepo !== false;
  mockExecFileSync.mockImplementation((_cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') {
      if (!isRepo) throw new Error('not a git repository');
      return Buffer.from('true');
    }
    if (argList[0] === 'log') {
      const lines = (opts.logCommits ?? []).map((c) => `${c.sha}|${c.date}T10:00:00Z`);
      return Buffer.from(lines.join('\n'));
    }
    if (argList[0] === 'show') {
      const ref = argList[1] ?? '';
      const sha = ref.split(':')[0];
      const content = opts.contentForSha ? opts.contentForSha(sha) : SAMPLE_SRC;
      return Buffer.from(content);
    }
    if (argList[0] === 'grep') {
      // Synthesise `<sha>:<file>` lines so importer count is opts.importerCount.
      const n = opts.importerCount ?? 0;
      const lines: string[] = [];
      for (let i = 0; i < n; i++) lines.push(`fakesha:src/importer${i}.ts`);
      return Buffer.from(lines.join('\n'));
    }
    return Buffer.from('');
  });
}

describe('getCouplingTrend() — behavioural contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns snapshots with ca/ce/instability fields', () => {
    const store = createTestStore();
    store.insertFile('src/x.ts', 'typescript', 'h1', 200);

    mockGit({
      logCommits: [
        { sha: 'sha1aaaaaa', date: '2026-01-19' },
        { sha: 'sha2bbbbbb', date: '2026-01-12' },
      ],
      importerCount: 2,
    });

    const result = getCouplingTrend(store, '/project', 'src/x.ts', { snapshots: 2 });
    expect(result).not.toBeNull();
    expect(result!.file).toBe('src/x.ts');
    expect(result!.current).toBeDefined();
    expect(typeof result!.current.ca).toBe('number');
    expect(typeof result!.current.ce).toBe('number');
    expect(typeof result!.current.instability).toBe('number');
    expect(Array.isArray(result!.historical)).toBe(true);
    expect(result!.historical.length).toBeGreaterThan(0);
    for (const snap of result!.historical) {
      expect(typeof snap.ca).toBe('number');
      expect(typeof snap.ce).toBe('number');
      expect(typeof snap.instability).toBe('number');
      expect(snap.instability).toBeGreaterThanOrEqual(0);
      expect(snap.instability).toBeLessThanOrEqual(1);
    }
    expect(['stabilizing', 'stable', 'destabilizing']).toContain(result!.trend);
  });

  it('since_days is propagated to git log as --since', () => {
    const store = createTestStore();
    store.insertFile('src/y.ts', 'typescript', 'h2', 200);

    mockGit({
      logCommits: [{ sha: 'sha1aaaaaa', date: '2026-01-19' }],
      importerCount: 0,
    });

    getCouplingTrend(store, '/project', 'src/y.ts', { sinceDays: 45, snapshots: 1 });

    const logCall = mockExecFileSync.mock.calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return args[0] === 'log';
    });
    expect(logCall).toBeDefined();
    const argList = (logCall![1] ?? []) as string[];
    expect(argList.some((a) => /^--since=45 days ago$/.test(a))).toBe(true);
  });

  it('non-git directory returns null', () => {
    const store = createTestStore();
    store.insertFile('src/x.ts', 'typescript', 'h3', 200);
    mockGit({ isRepo: false });

    const result = getCouplingTrend(store, '/not-a-repo', 'src/x.ts');
    expect(result).toBeNull();
  });

  it('unknown file (not in index) returns null', () => {
    const store = createTestStore();
    mockGit({ logCommits: [], importerCount: 0 });

    const result = getCouplingTrend(store, '/project', 'src/ghost.ts');
    expect(result).toBeNull();
  });
});
