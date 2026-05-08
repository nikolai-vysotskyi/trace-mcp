/**
 * Complexity trend analysis — compare current complexity with historical.
 *
 * Uses git to check out previous versions of files and compute complexity
 * at different points in time, showing whether code is getting more or less complex.
 */

import { execFileSync } from 'node:child_process';
import type { Store } from '../../db/store.js';
import { logger } from '../../logger.js';
import { isSafeGitRef, safeGitEnv } from '../../utils/git-env.js';
import { isGitRepo } from '../git/git-analysis.js';
import { computeCyclomatic, computeMaxNesting } from './complexity.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface ComplexitySnapshot {
  date: string;
  commit: string;
  max_cyclomatic: number;
  avg_cyclomatic: number;
  max_nesting: number;
  functions_counted: number;
}

interface ComplexityTrendEntry {
  file: string;
  current: ComplexitySnapshot;
  historical: ComplexitySnapshot[];
  trend: 'improving' | 'stable' | 'degrading';
  /** Change in avg cyclomatic from oldest snapshot to current */
  delta: number;
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

/** Get commit hashes at regular intervals for a file. */
function getHistoricalCommits(
  cwd: string,
  filePath: string,
  count: number,
): Array<{ hash: string; date: string }> {
  try {
    const output = execFileSync(
      'git',
      [
        'log',
        '--pretty=format:%H|%aI',
        '--follow',
        `--max-count=${count * 3}`, // over-fetch to sample evenly
        '--',
        filePath,
      ],
      {
        cwd,
        stdio: 'pipe',
        timeout: 10_000,
        env: safeGitEnv(),
      },
    ).toString('utf-8');

    const all = output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, date] = line.split('|');
        return { hash, date: date.split('T')[0] };
      });

    if (all.length <= count) return all;

    // Sample evenly: always include first (newest) and last (oldest)
    const step = Math.max(1, Math.floor((all.length - 1) / (count - 1)));
    const sampled: typeof all = [];
    for (let i = 0; i < all.length && sampled.length < count; i += step) {
      sampled.push(all[i]);
    }
    // Always include oldest
    if (sampled[sampled.length - 1] !== all[all.length - 1]) {
      sampled.push(all[all.length - 1]);
    }
    return sampled;
  } catch {
    return [];
  }
}

/** Get file content at a specific commit.
 * `commitHash` is validated as a safe git ref so a value starting with `-`
 * cannot be reinterpreted by `git show` as a flag. */
function getFileAtCommit(cwd: string, filePath: string, commitHash: string): string | null {
  if (!isSafeGitRef(commitHash)) return null;
  try {
    return execFileSync('git', ['show', `${commitHash}:${filePath}`], {
      cwd,
      stdio: 'pipe',
      timeout: 10_000,
      env: safeGitEnv(),
    }).toString('utf-8');
  } catch (e) {
    // File may not exist at this commit (e.g., before creation or rename)
    logger.debug(
      { file: filePath, commit: commitHash, error: e },
      'git show failed (file may not exist at this commit)',
    );
    return null;
  }
}

/** Compute complexity snapshot from raw file content. */
function computeSnapshot(content: string, commitHash: string, date: string): ComplexitySnapshot {
  // Split into function-like blocks using a simple heuristic:
  // find lines matching function/method signatures
  const funcPattern =
    /^(?:export\s+)?(?:async\s+)?(?:function|const\s+\w+\s*=|(?:public|private|protected)\s+(?:async\s+)?(?:static\s+)?\w+\s*\()/;
  const lines = content.split('\n');
  const funcStarts: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (funcPattern.test(lines[i])) {
      funcStarts.push(i);
    }
  }

  if (funcStarts.length === 0) {
    // Treat entire file as one block
    const cc = computeCyclomatic(content);
    const nest = computeMaxNesting(content);
    return {
      date,
      commit: commitHash.slice(0, 8),
      max_cyclomatic: cc,
      avg_cyclomatic: cc,
      max_nesting: nest,
      functions_counted: 1,
    };
  }

  // Compute complexity for each function block
  const complexities: number[] = [];
  let maxNesting = 0;

  for (let i = 0; i < funcStarts.length; i++) {
    const start = funcStarts[i];
    const end = i + 1 < funcStarts.length ? funcStarts[i + 1] : lines.length;
    const block = lines.slice(start, end).join('\n');
    complexities.push(computeCyclomatic(block));
    maxNesting = Math.max(maxNesting, computeMaxNesting(block));
  }

  const maxCc = Math.max(...complexities);
  const avgCc =
    Math.round((complexities.reduce((a, b) => a + b, 0) / complexities.length) * 100) / 100;

  return {
    date,
    commit: commitHash.slice(0, 8),
    max_cyclomatic: maxCc,
    avg_cyclomatic: avgCc,
    max_nesting: maxNesting,
    functions_counted: complexities.length,
  };
}

// ════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════

export function getComplexityTrend(
  store: Store,
  cwd: string,
  filePath: string,
  options: { snapshots?: number } = {},
): ComplexityTrendEntry | null {
  const { snapshots = 5 } = options;

  if (!isGitRepo(cwd)) return null;

  // Current state from index
  const file = store.getFile(filePath);
  if (!file) return null;

  const currentSymbols = store.db
    .prepare(`
    SELECT cyclomatic, max_nesting FROM symbols
    WHERE file_id = ? AND cyclomatic IS NOT NULL
  `)
    .all(file.id) as Array<{ cyclomatic: number; max_nesting: number }>;

  let currentSnapshot: ComplexitySnapshot;
  if (currentSymbols.length > 0) {
    const maxCc = Math.max(...currentSymbols.map((s) => s.cyclomatic));
    const avgCc =
      Math.round(
        (currentSymbols.reduce((sum, s) => sum + s.cyclomatic, 0) / currentSymbols.length) * 100,
      ) / 100;
    const maxNest = Math.max(...currentSymbols.map((s) => s.max_nesting));
    currentSnapshot = {
      date: new Date().toISOString().split('T')[0],
      commit: 'HEAD',
      max_cyclomatic: maxCc,
      avg_cyclomatic: avgCc,
      max_nesting: maxNest,
      functions_counted: currentSymbols.length,
    };
  } else {
    return null; // No complexity data
  }

  // Historical snapshots
  const commits = getHistoricalCommits(cwd, filePath, snapshots);
  const historical: ComplexitySnapshot[] = [];

  for (const { hash, date } of commits) {
    const content = getFileAtCommit(cwd, filePath, hash);
    if (!content) continue;
    try {
      historical.push(computeSnapshot(content, hash, date));
    } catch (e) {
      logger.warn({ file: filePath, commit: hash, error: e }, 'Complexity snapshot failed');
    }
  }

  // Determine trend
  let trend: ComplexityTrendEntry['trend'] = 'stable';
  let delta = 0;

  if (historical.length > 0) {
    const oldest = historical[historical.length - 1];
    delta = Math.round((currentSnapshot.avg_cyclomatic - oldest.avg_cyclomatic) * 100) / 100;
    if (delta > 1) trend = 'degrading';
    else if (delta < -1) trend = 'improving';
  }

  return {
    file: filePath,
    current: currentSnapshot,
    historical,
    trend,
    delta,
  };
}
