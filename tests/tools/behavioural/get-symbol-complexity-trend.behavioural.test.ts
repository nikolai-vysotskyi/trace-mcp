/**
 * Behavioural coverage for `getSymbolComplexityTrend()` in
 * `src/tools/analysis/history.ts` (the implementation behind the
 * `get_symbol_complexity_trend` MCP tool). Git is mocked via
 * `node:child_process.execFileSync`.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSymbolComplexityTrend } from '../../../src/tools/analysis/history.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

const FN_SRC = `
export function calc(a: number, b: number): number {
  if (a < 0) return -1;
  if (b < 0) return -2;
  let total = 0;
  for (let i = 0; i < a; i++) {
    if (i % 2 === 0) total += b;
    else total -= b;
  }
  return total;
}
`.trim();

function mockGit(opts: {
  isRepo?: boolean;
  logCommits?: Array<{ sha: string; date: string }>;
  content?: string;
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
      return Buffer.from(opts.content ?? FN_SRC);
    }
    return Buffer.from('');
  });
}

function seedSymbol(store: ReturnType<typeof createTestStore>): {
  symbolId: string;
} {
  const fileId = store.insertFile('src/x.ts', 'typescript', 'h1', 200);
  store.db
    .prepare(
      `INSERT INTO symbols (file_id, symbol_id, name, kind, fqn, byte_start, byte_end, line_start, line_end, cyclomatic, max_nesting, param_count)
       VALUES (?, 'src/x.ts::calc#function', 'calc', 'function', 'calc', 0, 200, 1, 10, 5, 2, 2)`,
    )
    .run(fileId);
  return { symbolId: 'src/x.ts::calc#function' };
}

describe('getSymbolComplexityTrend() — behavioural contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { symbol_id, snapshots } with cyclomatic/nesting/params/lines per snapshot', () => {
    const store = createTestStore();
    const { symbolId } = seedSymbol(store);

    mockGit({
      logCommits: [
        { sha: 'sha1aaaaaa', date: '2026-01-19' },
        { sha: 'sha2bbbbbb', date: '2026-01-12' },
      ],
      content: FN_SRC,
    });

    const result = getSymbolComplexityTrend(store, '/project', symbolId, { snapshots: 2 });
    expect(result).not.toBeNull();
    expect(result!.symbol_id).toBe(symbolId);
    expect(result!.name).toBe('calc');
    expect(result!.current).toBeDefined();
    expect(typeof result!.current.cyclomatic).toBe('number');
    expect(typeof result!.current.max_nesting).toBe('number');
    expect(typeof result!.current.param_count).toBe('number');
    expect(typeof result!.current.lines).toBe('number');
    expect(Array.isArray(result!.historical)).toBe(true);
    expect(result!.historical.length).toBeGreaterThan(0);
    for (const snap of result!.historical) {
      expect(typeof snap.cyclomatic).toBe('number');
      expect(typeof snap.max_nesting).toBe('number');
      expect(typeof snap.param_count).toBe('number');
      expect(typeof snap.lines).toBe('number');
    }
    expect(['improving', 'stable', 'degrading']).toContain(result!.trend);
    expect(typeof result!.cyclomatic_delta).toBe('number');
  });

  it('since_days is propagated to git log as --since', () => {
    const store = createTestStore();
    const { symbolId } = seedSymbol(store);

    mockGit({
      logCommits: [{ sha: 'sha1aaaaaa', date: '2026-01-19' }],
      content: FN_SRC,
    });

    getSymbolComplexityTrend(store, '/project', symbolId, { sinceDays: 60, snapshots: 1 });

    const logCall = mockExecFileSync.mock.calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return args[0] === 'log';
    });
    expect(logCall).toBeDefined();
    const argList = (logCall![1] ?? []) as string[];
    expect(argList.some((a) => /^--since=60 days ago$/.test(a))).toBe(true);
  });

  it('unknown symbol_id returns null without throwing', () => {
    const store = createTestStore();
    seedSymbol(store);
    mockGit({ logCommits: [{ sha: 'sha1aaaaaa', date: '2026-01-19' }], content: FN_SRC });

    const result = getSymbolComplexityTrend(store, '/project', 'src/nope.ts::ghost#function');
    expect(result).toBeNull();
  });

  it('empty git history → empty historical snapshots, but current still present', () => {
    const store = createTestStore();
    const { symbolId } = seedSymbol(store);

    mockGit({ logCommits: [], content: FN_SRC });

    const result = getSymbolComplexityTrend(store, '/project', symbolId, { snapshots: 3 });
    expect(result).not.toBeNull();
    expect(result!.historical.length).toBe(0);
    expect(result!.current).toBeDefined();
    expect(result!.trend).toBe('stable'); // no historical → delta=0 → stable
    expect(result!.cyclomatic_delta).toBe(0);
  });
});
