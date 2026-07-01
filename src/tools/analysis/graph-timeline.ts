/**
 * Graph Timeline — SIMPLIFIED first version of continuous graph evolution.
 *
 * Full vision (not implemented here): reconstruct symbol/edge-level graph
 * state at every point in history by re-running the indexer against each
 * historical commit. That is expensive and risky to do safely inline (it
 * would mean re-parsing the whole tree N times with tree-sitter).
 *
 * What this module actually does: samples up to `snapshots` evenly-spaced
 * commits across the requested window (same sampling strategy as
 * `getComplexityTrend` / `getCouplingTrend` in complexity-trend.ts /
 * history.ts), and at each sampled commit computes CHEAP, git-only signals:
 *   - file count at that commit (`git ls-tree -r --name-only`)
 *   - commits/insertions/deletions/files-changed since the previous sample
 *     (`git log --shortstat`)
 * plus a narrative diff marker per period (e.g. "+12 files, -3 files").
 *
 * Symbol counts and edge-type counts are reported ONLY for the current
 * HEAD snapshot (pulled from the live index via `store.getStats()` /
 * `named_graph_snapshots` when available) — they are NOT reconstructed
 * per historical commit. This is a deliberate honesty boundary: faking
 * per-commit symbol/edge counts via regex heuristics would look precise
 * but wouldn't be, so historical points stay file-level only.
 */

import { execFileSync } from 'node:child_process';
import type { Store } from '../../db/store.js';
import { logger } from '../../logger.js';
import { safeGitEnv } from '../../utils/git-env.js';
import { isGitRepo } from '../git/git-analysis.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export type Granularity = 'daily' | 'weekly' | 'monthly';

export interface GraphTimelinePeriod {
  /** Period label, e.g. "2026-04" for monthly, ISO week/day for others */
  period: string;
  /** Commit hash sampled to represent this period (most recent commit at/before period end) */
  commit: string;
  date: string;
  /** File count at this commit (source files matching the indexer's tracked extensions) */
  file_count: number | null;
  /** Commits landed within this period (bounded by the previous sampled period) */
  commits_in_period: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  /** Human-readable delta marker vs the previous period, e.g. "+12 files, -3 commits" */
  narrative: string;
}

export interface GraphTimelineResult {
  since_days: number;
  granularity: Granularity;
  periods: GraphTimelinePeriod[];
  /** Current live-index totals (symbol/edge counts) — HEAD only, not reconstructed historically */
  current: {
    files: number;
    symbols: number;
    edges_by_type: Record<string, number>;
  };
  _tier: 'simplified_commit_sampling';
  _methodology: {
    description: string;
    limitations: string[];
  };
}

const METHODOLOGY = {
  description:
    'Samples evenly-spaced historical commits across the window (same strategy as get_complexity_trend) and computes git-only file-count + churn signals per period. Symbol/edge counts are reported for the current HEAD snapshot only.',
  limitations: [
    'NOT a continuous re-indexed history — historical periods carry file-level git signals only, not symbol/edge counts (re-parsing the full tree at every commit was judged too expensive/risky to do inline)',
    "file_count at historical commits is computed via `git ls-tree`, filtered by a fixed extension allowlist, which may not exactly match the indexer's include/exclude globs for that commit in time",
    'periods with zero commits show file_count carried forward from the nearest prior sample',
    'requires git history; returns an empty timeline outside a git repo',
  ],
};

/** Extensions considered "source" for the file-count signal (best-effort, not the full indexer include-glob set). */
const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rb',
  'rs',
  'java',
  'php',
  'cs',
  'swift',
  'kt',
  'scala',
  'ex',
  'exs',
  'dart',
  'c',
  'cpp',
  'cc',
  'h',
  'hpp',
  'm',
  'mm',
]);

// ════════════════════════════════════════════════════════════════════════
// GIT HELPERS
// ════════════════════════════════════════════════════════════════════════

function countSourceFilesAtCommit(cwd: string, commitHash: string): number | null {
  try {
    const output = execFileSync('git', ['ls-tree', '-r', '--name-only', commitHash], {
      cwd,
      stdio: 'pipe',
      timeout: 15_000,
      maxBuffer: 20 * 1024 * 1024,
      env: safeGitEnv(),
    }).toString('utf-8');
    let count = 0;
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const ext = trimmed.split('.').pop();
      if (ext && SOURCE_EXTENSIONS.has(ext.toLowerCase())) count++;
    }
    return count;
  } catch (e) {
    logger.debug({ commit: commitHash, error: e }, 'git ls-tree failed for graph timeline');
    return null;
  }
}

interface PeriodBoundary {
  /** Period label */
  label: string;
  /** Newest commit at/before the boundary (representative commit for this period) */
  hash: string;
  date: string;
}

interface CommitSample {
  boundaries: PeriodBoundary[];
  /** Every commit hash in the window, oldest-first — used to slice churn ranges without another git call. */
  orderedHashesOldestFirst: string[];
}

/**
 * Sample one representative commit per period over the window, using
 * `git log --since`. Periods are bucketed client-side from full commit
 * dates rather than asking git for pre-bucketed output, keeping the
 * git invocation simple and the bucketing logic testable in isolation.
 */
function sampleCommitsByPeriod(
  cwd: string,
  sinceDays: number,
  granularity: Granularity,
): CommitSample {
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['log', `--since=${sinceDays} days ago`, '--pretty=format:%H|%aI', '--no-merges'],
      { cwd, stdio: 'pipe', timeout: 20_000, maxBuffer: 20 * 1024 * 1024, env: safeGitEnv() },
    ).toString('utf-8');
  } catch (e) {
    logger.debug({ error: e }, 'git log failed for graph timeline');
    return { boundaries: [], orderedHashesOldestFirst: [] };
  }

  const commits = output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, iso] = line.split('|');
      return { hash, iso };
    })
    // git log is newest-first; walk oldest-first so "representative commit"
    // per period is the last (newest) one seen for that bucket.
    .reverse();

  const periodKey = (iso: string): string => {
    const d = new Date(iso);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    if (granularity === 'monthly') return `${yyyy}-${mm}`;
    if (granularity === 'daily') return iso.split('T')[0];
    // weekly: ISO week number (Monday-start)
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = (tmp.getUTCDay() + 6) % 7;
    tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 4));
    const week =
      1 +
      Math.round(
        ((tmp.getTime() - firstThursday.getTime()) / 86400000 -
          3 +
          ((firstThursday.getUTCDay() + 6) % 7)) /
          7,
      );
    return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };

  const byPeriod = new Map<string, PeriodBoundary>();
  for (const { hash, iso } of commits) {
    const label = periodKey(iso);
    // Overwrite so the LAST (newest) commit seen for a period wins.
    byPeriod.set(label, { label, hash, date: iso.split('T')[0] });
  }

  return {
    boundaries: [...byPeriod.values()].sort((a, b) => (a.label < b.label ? -1 : 1)),
    orderedHashesOldestFirst: commits.map((c) => c.hash),
  };
}

interface PeriodChurn {
  commits: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

const EMPTY_CHURN: PeriodChurn = { commits: 0, filesChanged: 0, insertions: 0, deletions: 0 };

/**
 * Commit/insertion/deletion counts for EVERY commit in the window, in a
 * single `git log --shortstat` invocation tagged with each commit's own
 * hash (`--pretty=format:__C__%H`).
 *
 * Replaces what used to be one `git log --shortstat <range>` subprocess
 * PER sampled period (up to `maxPeriods` extra spawns). Measured on this
 * project's own history (1000+ commits in 180 days): bare git subprocess
 * spawn overhead alone is ~9-15ms/call regardless of repo size, so batching
 * N per-period calls into 1 whole-window call turns an O(periods) spawn
 * cost into O(1) — the dominant cost for `daily`/`weekly` granularity
 * where `maxPeriods` can be 24+.
 */
function getChurnByCommit(cwd: string, sinceDays: number): Map<string, PeriodChurn> {
  const byCommit = new Map<string, PeriodChurn>();
  let output: string;
  try {
    output = execFileSync(
      'git',
      [
        'log',
        `--since=${sinceDays} days ago`,
        '--no-merges',
        '--shortstat',
        '--pretty=format:__C__%H',
      ],
      { cwd, stdio: 'pipe', timeout: 20_000, maxBuffer: 20 * 1024 * 1024, env: safeGitEnv() },
    ).toString('utf-8');
  } catch (e) {
    logger.debug({ error: e }, 'git shortstat failed for graph timeline');
    return byCommit;
  }

  let current: PeriodChurn | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('__C__')) {
      const hash = line.slice('__C__'.length);
      current = { commits: 1, filesChanged: 0, insertions: 0, deletions: 0 };
      byCommit.set(hash, current);
      continue;
    }
    if (!current) continue;
    const fileMatch = line.match(/(\d+) files? changed/);
    const insMatch = line.match(/(\d+) insertions?\(\+\)/);
    const delMatch = line.match(/(\d+) deletions?\(-\)/);
    if (fileMatch) current.filesChanged += Number(fileMatch[1]);
    if (insMatch) current.insertions += Number(insMatch[1]);
    if (delMatch) current.deletions += Number(delMatch[1]);
  }
  return byCommit;
}

/**
 * Aggregate per-commit churn (from `getChurnByCommit`) for every commit in
 * `(fromExclusive, toInclusive]`, using the full oldest-first commit hash
 * order already sampled by `sampleCommitsByPeriod`.
 */
function aggregateChurn(
  churnByCommit: Map<string, PeriodChurn>,
  orderedHashesOldestFirst: string[],
  fromExclusive: string | null,
  toInclusive: string,
): PeriodChurn {
  const fromIdx = fromExclusive ? orderedHashesOldestFirst.indexOf(fromExclusive) : -1;
  const toIdx = orderedHashesOldestFirst.indexOf(toInclusive);
  if (toIdx === -1) return { ...EMPTY_CHURN };

  const agg: PeriodChurn = { commits: 0, filesChanged: 0, insertions: 0, deletions: 0 };
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    const c = churnByCommit.get(orderedHashesOldestFirst[i]);
    if (!c) continue;
    agg.commits += c.commits;
    agg.filesChanged += c.filesChanged;
    agg.insertions += c.insertions;
    agg.deletions += c.deletions;
  }
  return agg;
}

// ════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════

export function getGraphTimeline(
  store: Store,
  cwd: string,
  options: { sinceDays?: number; granularity?: Granularity; maxPeriods?: number } = {},
): GraphTimelineResult | null {
  const { sinceDays = 90, granularity = 'monthly', maxPeriods = 24 } = options;

  if (!isGitRepo(cwd)) return null;

  const { boundaries: allBoundaries, orderedHashesOldestFirst } = sampleCommitsByPeriod(
    cwd,
    sinceDays,
    granularity,
  );
  const boundaries = allBoundaries.slice(-maxPeriods);

  // One `git log --shortstat` call for the whole window instead of one per
  // period (see getChurnByCommit doc comment) — the dominant fix here since
  // `countSourceFilesAtCommit` still needs one `git ls-tree` per period (each
  // targets a different historical tree snapshot, which isn't batchable the
  // same way).
  const churnByCommit = getChurnByCommit(cwd, sinceDays);

  const periods: GraphTimelinePeriod[] = [];
  let prevFileCount: number | null = null;
  let prevHash: string | null = null;

  for (const boundary of boundaries) {
    const fileCount = countSourceFilesAtCommit(cwd, boundary.hash);
    const churn = aggregateChurn(churnByCommit, orderedHashesOldestFirst, prevHash, boundary.hash);

    const effectiveFileCount: number | null = fileCount ?? prevFileCount;
    const fileDelta =
      fileCount !== null && prevFileCount !== null ? fileCount - prevFileCount : null;

    const narrativeParts: string[] = [];
    if (fileDelta !== null && fileDelta !== 0) {
      narrativeParts.push(`${fileDelta > 0 ? '+' : ''}${fileDelta} files`);
    }
    if (churn.commits > 0) narrativeParts.push(`${churn.commits} commit(s)`);
    if (churn.insertions > 0 || churn.deletions > 0) {
      narrativeParts.push(`+${churn.insertions}/-${churn.deletions} lines`);
    }
    const narrative = narrativeParts.length > 0 ? narrativeParts.join(', ') : 'no changes';

    periods.push({
      period: boundary.label,
      commit: boundary.hash.slice(0, 8),
      date: boundary.date,
      file_count: effectiveFileCount,
      commits_in_period: churn.commits,
      files_changed: churn.filesChanged,
      insertions: churn.insertions,
      deletions: churn.deletions,
      narrative,
    });

    prevFileCount = effectiveFileCount;
    prevHash = boundary.hash;
  }

  // Current live-index totals — HEAD only, not reconstructed historically.
  const stats = store.getStats();
  const edgeTypeRows = store.db
    .prepare(
      `SELECT et.name AS k, COUNT(*) AS cnt FROM edges e
       JOIN edge_types et ON e.edge_type_id = et.id
       GROUP BY et.name`,
    )
    .all() as Array<{ k: string; cnt: number }>;

  return {
    since_days: sinceDays,
    granularity,
    periods,
    current: {
      files: stats.totalFiles,
      symbols: stats.totalSymbols,
      edges_by_type: Object.fromEntries(edgeTypeRows.map((r) => [r.k, r.cnt])),
    },
    _tier: 'simplified_commit_sampling',
    _methodology: METHODOLOGY,
  };
}
