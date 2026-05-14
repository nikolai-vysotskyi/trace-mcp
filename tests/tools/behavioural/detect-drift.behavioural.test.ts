/**
 * Behavioural coverage for `detectDrift()` in
 * `src/tools/analysis/predictive-intelligence.ts` (the implementation behind
 * the `detect_drift` MCP tool). Surfaces cross-module co-change anomalies
 * (Jaccard confidence over the in-window git log) and shotgun-surgery
 * commits (3+ distinct modules touched at once). Git is mocked via
 * `node:child_process.execFileSync` for determinism.
 *
 * Note: the implementation's public output shape is `co_change_anomalies`
 * and `shotgun_surgery`, not the `anomalies` / `shotgunSurgery` short names
 * mentioned in the user-facing tool description.
 */

import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { detectDrift } from '../../../src/tools/analysis/predictive-intelligence.js';
import { createTestStore } from '../../test-utils.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

interface Commit {
  date: string;
  files: string[];
}

/** Drive predictive-intelligence's `getCommitFileGroups` git log call. */
function mockGitWithCommits(commits: Commit[]): void {
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') return Buffer.from('true');
    if (argList[0] === 'log') {
      const lines: string[] = [];
      let counter = 0;
      for (const c of commits) {
        counter++;
        // Match the pretty-format used by getCommitFileGroups in
        // predictive-intelligence.ts. The exact field count beyond the date
        // doesn't matter as long as files appear on subsequent lines and the
        // commit marker prefix is recognised.
        lines.push(`__COMMIT__sha${counter}|${c.date}|Alice|msg${counter}`);
        for (const f of c.files) lines.push(f);
      }
      return Buffer.from(lines.join('\n'));
    }
    return Buffer.from('');
  });
}

function mockNonGit(): void {
  mockExecFileSync.mockImplementation((cmd: string, args: readonly string[] | undefined) => {
    const argList = (args ?? []) as string[];
    if (argList[0] === 'rev-parse') {
      throw new Error('not a git repository');
    }
    return Buffer.from('');
  });
}

describe('detectDrift() — behavioural contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('seeded cross-module co-changes surface as anomalies above confidence cutoff', () => {
    const store = createTestStore();
    // 5 commits, each touches two files in different modules (auth/, billing/).
    // → Jaccard = 5 / (5 + 5 - 5) = 1.0, well above the 0.3 default cutoff.
    const commits: Commit[] = [];
    for (let i = 1; i <= 5; i++) {
      commits.push({
        date: `2026-01-${String(i).padStart(2, '0')}T10:00:00Z`,
        files: ['src/auth/login.ts', 'src/billing/charge.ts'],
      });
    }
    mockGitWithCommits(commits);

    const result = detectDrift(store, '/project');
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();
    expect(report.co_change_anomalies.length).toBeGreaterThan(0);
    const top = report.co_change_anomalies[0];
    // The pair is ordered lexicographically when grouped, so module_a/module_b
    // mirror that ordering. Just assert both modules appear.
    const modules = [top.module_a, top.module_b].sort();
    expect(modules).toEqual(['src/auth', 'src/billing']);
    expect(top.confidence).toBeGreaterThanOrEqual(0.3);
    expect(top.co_change_count).toBe(5);
  });

  it('commits touching 3+ modules surface as shotgun_surgery hotspots', () => {
    const store = createTestStore();
    // 5 commits, each touches 3 distinct modules → ratio 1.0 (>0.3) for every file.
    const commits: Commit[] = [];
    for (let i = 1; i <= 5; i++) {
      commits.push({
        date: `2026-01-${String(i).padStart(2, '0')}T10:00:00Z`,
        files: ['src/auth/a.ts', 'src/billing/b.ts', 'src/ui/c.ts'],
      });
    }
    mockGitWithCommits(commits);

    const result = detectDrift(store, '/project');
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();
    expect(report.shotgun_surgery.length).toBeGreaterThan(0);
    const files = report.shotgun_surgery.map((s) => s.file).sort();
    expect(files).toEqual(['src/auth/a.ts', 'src/billing/b.ts', 'src/ui/c.ts']);
    for (const entry of report.shotgun_surgery) {
      expect(entry.shotgun_commits).toBe(5);
      expect(entry.total_commits).toBe(5);
      expect(entry.ratio).toBe(1);
    }
    expect(report.summary.shotgun_hotspots).toBe(report.shotgun_surgery.length);
  });

  it('min_confidence cutoff drops anomalies below the threshold', () => {
    const store = createTestStore();
    // 1 co-change for the pair, each file has 10 solo commits → Jaccard ≈ 1/20 = 0.05.
    const commits: Commit[] = [];
    commits.push({
      date: '2026-01-01T10:00:00Z',
      files: ['src/auth/login.ts', 'src/billing/charge.ts'],
    });
    for (let i = 0; i < 9; i++) {
      commits.push({
        date: `2026-01-${String(i + 2).padStart(2, '0')}T10:00:00Z`,
        files: ['src/auth/login.ts'],
      });
      commits.push({
        date: `2026-02-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
        files: ['src/billing/charge.ts'],
      });
    }
    mockGitWithCommits(commits);

    // 0.3 default → low-confidence pair must be filtered out.
    const filtered = detectDrift(store, '/project', { minConfidence: 0.3 });
    expect(filtered.isOk()).toBe(true);
    expect(filtered._unsafeUnwrap().co_change_anomalies.length).toBe(0);

    // Drop the cutoff → the pair should surface.
    const permissive = detectDrift(store, '/project', { minConfidence: 0.01 });
    expect(permissive.isOk()).toBe(true);
    expect(permissive._unsafeUnwrap().co_change_anomalies.length).toBeGreaterThan(0);
  });

  it('since_days window is propagated to git log as --since', () => {
    const store = createTestStore();
    mockGitWithCommits([
      { date: '2026-01-01T10:00:00Z', files: ['src/auth/a.ts', 'src/billing/b.ts'] },
    ]);
    detectDrift(store, '/project', { sinceDays: 45 });

    const logCall = mockExecFileSync.mock.calls.find((c) => {
      const args = (c[1] ?? []) as string[];
      return args[0] === 'log';
    });
    expect(logCall).toBeDefined();
    const argList = (logCall![1] ?? []) as string[];
    expect(argList.some((a) => /^--since=45 days ago$/.test(a))).toBe(true);
  });

  it('non-git directory returns empty drift report (per methodology fallback)', () => {
    const store = createTestStore();
    mockNonGit();

    const result = detectDrift(store, '/not-a-repo');
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();
    expect(report.co_change_anomalies).toEqual([]);
    expect(report.shotgun_surgery).toEqual([]);
    expect(report.summary.total_anomalies).toBe(0);
    expect(report.summary.shotgun_hotspots).toBe(0);
  });
});
