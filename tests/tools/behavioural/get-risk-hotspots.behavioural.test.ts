/**
 * Behavioural coverage for `getHotspots()` in
 * `src/tools/git/git-analysis.ts` (the implementation behind the
 * `get_risk_hotspots` MCP tool). Score = max_cyclomatic × log(1 + commits).
 * Each entry carries a `confidence_level` counting how many of the two
 * independent signals (complexity > 10, commits > 5) actually fired.
 *
 * Git is mocked via `node:child_process.execFileSync` so we can drive the
 * commit count deterministically.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../../../src/db/store.js';
import { getHotspots } from '../../../src/tools/git/git-analysis.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

function insertFileWithComplexity(store: Store, path: string, cyclomatic: number): number {
  const fileId = store.insertFile(path, 'typescript', `hash_${path}`, 100);
  store.insertSymbol(fileId, {
    symbolId: `${path}::main#function`,
    name: 'main',
    kind: 'function',
    fqn: 'main',
    byteStart: 0,
    byteEnd: 100,
    lineStart: 1,
    lineEnd: 30,
    metadata: { cyclomatic, max_nesting: 2, param_count: 1 },
  });
  return fileId;
}

/** Pretend the project IS a git repo and stream synthetic commits for given files. */
function mockGitWith(commitsByFile: Record<string, number>): void {
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') return Buffer.from('true');
    if (argList[0] === 'log') {
      const lines: string[] = [];
      let counter = 0;
      for (const [file, n] of Object.entries(commitsByFile)) {
        for (let i = 0; i < n; i++) {
          counter++;
          lines.push(
            `__COMMIT__sha${counter}|2026-03-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z|Alice`,
          );
          lines.push(file);
        }
      }
      return Buffer.from(lines.join('\n'));
    }
    return Buffer.from('');
  });
}

describe('getHotspots() — behavioural contract', () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createTestStore();
  });

  it('score equals complexity × log(1 + commits) for each file', () => {
    insertFileWithComplexity(store, 'src/hot.ts', 12);
    mockGitWith({ 'src/hot.ts': 5 });

    const result = getHotspots(store, '/project');
    expect(result.length).toBe(1);
    const entry = result[0];
    expect(entry.file).toBe('src/hot.ts');
    expect(entry.max_cyclomatic).toBe(12);
    expect(entry.commits).toBe(5);
    // 12 × log(1+5) ≈ 21.5 (rounded to 2 decimals)
    const expected = Math.round(12 * Math.log(1 + 5) * 100) / 100;
    expect(entry.score).toBe(expected);
  });

  it('min_cyclomatic filter excludes files below the threshold', () => {
    insertFileWithComplexity(store, 'src/simple.ts', 2);
    insertFileWithComplexity(store, 'src/risky.ts', 10);
    mockGitWith({ 'src/simple.ts': 5, 'src/risky.ts': 5 });

    const result = getHotspots(store, '/project', { minCyclomatic: 5 });
    expect(result.map((r) => r.file)).toEqual(['src/risky.ts']);
  });

  it('sinceDays window is propagated to the git log call as --since', () => {
    insertFileWithComplexity(store, 'src/hot.ts', 12);
    mockGitWith({ 'src/hot.ts': 3 });

    getHotspots(store, '/project', { sinceDays: 30 });

    // Find the git log call; assert the --since flag carries the requested window.
    const logCall = mockExecFileSync.mock.calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return args[0] === 'log';
    });
    expect(logCall).toBeDefined();
    const argList = (logCall![1] ?? []) as string[];
    expect(argList.some((a) => /^--since=/.test(a))).toBe(true);
  });

  it('confidence_level counts how many of complexity / churn signals fired', () => {
    // Two signals firing strongly: complexity > 10 AND commits > 5.
    insertFileWithComplexity(store, 'src/dual.ts', 12);
    // One signal: high complexity but only one commit.
    insertFileWithComplexity(store, 'src/mono.ts', 12);
    // Zero strong signals: low complexity, low churn (but still ≥ minCyclomatic default 3).
    insertFileWithComplexity(store, 'src/weak.ts', 4);
    mockGitWith({ 'src/dual.ts': 6, 'src/mono.ts': 1, 'src/weak.ts': 1 });

    const result = getHotspots(store, '/project');
    const dual = result.find((r) => r.file === 'src/dual.ts');
    const mono = result.find((r) => r.file === 'src/mono.ts');
    const weak = result.find((r) => r.file === 'src/weak.ts');
    expect(dual).toBeDefined();
    expect(mono).toBeDefined();
    expect(weak).toBeDefined();
    // classifyConfidence(signalsFired, maxSignals=2): 0→low, 1→medium, 2→medium.
    // What we care about is signals_fired counts the right inputs.
    expect(dual!.signals_fired).toBe(2);
    expect(mono!.signals_fired).toBe(1);
    expect(weak!.signals_fired).toBe(0);
    expect(weak!.confidence_level).toBe('low');
  });

  it('git unavailable → complexity-only fallback with confidence_level=low', () => {
    insertFileWithComplexity(store, 'src/complex.ts', 15);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not a git repo');
    });

    const result = getHotspots(store, '/project');
    expect(result.length).toBe(1);
    expect(result[0].file).toBe('src/complex.ts');
    expect(result[0].commits).toBe(0);
    expect(result[0].confidence_level).toBe('low');
    // Fallback score = complexity alone (no log multiplier).
    expect(result[0].score).toBe(15);
  });

  it('output sorted by score descending; limit caps result length', () => {
    insertFileWithComplexity(store, 'src/a.ts', 12);
    insertFileWithComplexity(store, 'src/b.ts', 12);
    insertFileWithComplexity(store, 'src/c.ts', 12);
    mockGitWith({ 'src/a.ts': 10, 'src/b.ts': 4, 'src/c.ts': 2 });

    const all = getHotspots(store, '/project');
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].score).toBeGreaterThanOrEqual(all[i].score);
    }
    expect(all[0].file).toBe('src/a.ts');

    const capped = getHotspots(store, '/project', { limit: 2 });
    expect(capped.length).toBeLessThanOrEqual(2);
  });
});
