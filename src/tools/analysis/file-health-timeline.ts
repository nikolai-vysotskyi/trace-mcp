/**
 * File Health Timeline — aggregates complexity trend, coupling trend, git
 * churn, and a lightweight per-snapshot risk score into ONE time-series
 * response per file, so "is this file getting healthier or worse over
 * time" is answerable in one call instead of chaining get_complexity_trend
 * + get_coupling_trend + get_git_churn (+ predict_bugs for the risk framing).
 *
 * Complexity and coupling snapshots are each sampled independently (they
 * live in separate modules with their own git-log calls) and merged here
 * by commit hash. Both use the same evenly-spaced sampling algorithm over
 * the file's `--follow` history, so with matching `snapshots` counts they
 * usually land on identical commits; when they don't, each period simply
 * reports whichever signals were actually resolved for that commit.
 */

import type { Store } from '../../db/store.js';
import { getComplexityTrend } from './complexity-trend.js';
import { getChurnRate, isGitRepo } from '../git/git-analysis.js';
import { getCouplingTrend } from './history.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface FileHealthPoint {
  date: string;
  commit: string;
  max_cyclomatic: number | null;
  avg_cyclomatic: number | null;
  ca: number | null;
  ce: number | null;
  instability: number | null;
  /**
   * Lightweight 0..1 risk score for this point, blending normalized
   * complexity and instability (git churn is reported separately as a
   * whole-window signal — see `churn` — since per-commit churn-at-a-point
   * isn't a meaningful quantity the way per-commit complexity/coupling are).
   */
  risk_score: number | null;
}

export interface FileHealthTimelineResult {
  file: string;
  since_days: number;
  current: FileHealthPoint;
  historical: FileHealthPoint[];
  churn: {
    commits: number;
    unique_authors: number;
    churn_per_week: number;
    assessment: 'stable' | 'active' | 'volatile' | null;
  };
  trend: 'improving' | 'stable' | 'degrading';
  _methodology: {
    description: string;
    limitations: string[];
  };
}

const METHODOLOGY = {
  description:
    'Merges get_complexity_trend and get_coupling_trend snapshots by commit hash, adds get_git_churn as a whole-window signal, and computes a per-point risk_score = 0.6 * normalized(max_cyclomatic, ceiling 20) + 0.4 * instability. trend compares the oldest resolved risk_score to the current one.',
  limitations: [
    'complexity and coupling snapshots are sampled independently and merged by commit hash; when the two samplers land on different commits for the same period, that period reports whichever signal(s) resolved',
    'risk_score is a simple heuristic blend, not the same scoring model as predict_bugs (which also factors churn rank, fix-commit ratio, PageRank, and author count) — use predict_bugs for cross-file bug-risk ranking',
    'requires git history; returns null outside a git repo or for unindexed files',
  ],
};

function clampNormalize(value: number, ceiling: number): number {
  return Math.min(1, value / ceiling);
}

function round(v: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

// ════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════

export function getFileHealthTimeline(
  store: Store,
  cwd: string,
  filePath: string,
  options: { sinceDays?: number; snapshots?: number } = {},
): FileHealthTimelineResult | null {
  const { sinceDays = 90, snapshots = 6 } = options;

  if (!isGitRepo(cwd)) return null;

  const file = store.getFile(filePath);
  if (!file) return null;

  const complexity = getComplexityTrend(store, cwd, filePath, { snapshots });
  const coupling = getCouplingTrend(store, cwd, filePath, { sinceDays, snapshots });

  if (!complexity && !coupling) return null;

  // Merge by commit hash (both trend functions truncate to 8 chars).
  const complexityByCommit = new Map(
    (complexity?.historical ?? []).map((s) => [s.commit, s] as const),
  );
  const couplingByCommit = new Map((coupling?.historical ?? []).map((s) => [s.commit, s] as const));
  const allCommits = new Set([...complexityByCommit.keys(), ...couplingByCommit.keys()]);

  // Preserve chronological order: both source arrays are newest-first,
  // sort merged commits by whichever snapshot has a date for them.
  const dateByCommit = new Map<string, string>();
  for (const s of complexity?.historical ?? []) dateByCommit.set(s.commit, s.date);
  for (const s of coupling?.historical ?? []) dateByCommit.set(s.commit, s.date);

  const orderedCommits = [...allCommits].sort((a, b) => {
    const da = dateByCommit.get(a) ?? '';
    const db = dateByCommit.get(b) ?? '';
    return db.localeCompare(da); // newest first, matching source ordering
  });

  function toPoint(commit: string, date: string): FileHealthPoint {
    const c = complexityByCommit.get(commit);
    const cp = couplingByCommit.get(commit);
    const maxCyclomatic = c?.max_cyclomatic ?? null;
    const instability = cp?.instability ?? null;

    let riskScore: number | null = null;
    if (maxCyclomatic !== null || instability !== null) {
      const complexityTerm = maxCyclomatic !== null ? clampNormalize(maxCyclomatic, 20) : 0;
      const instabilityTerm = instability ?? 0;
      const complexityWeight = maxCyclomatic !== null ? 0.6 : 0;
      const instabilityWeight = instability !== null ? 0.4 : 0;
      const totalWeight = complexityWeight + instabilityWeight;
      riskScore =
        totalWeight > 0
          ? round(
              (complexityWeight * complexityTerm + instabilityWeight * instabilityTerm) /
                totalWeight,
            )
          : null;
    }

    return {
      date,
      commit,
      max_cyclomatic: maxCyclomatic,
      avg_cyclomatic: c?.avg_cyclomatic ?? null,
      ca: cp?.ca ?? null,
      ce: cp?.ce ?? null,
      instability,
      risk_score: riskScore,
    };
  }

  const historical = orderedCommits.map((commit) => toPoint(commit, dateByCommit.get(commit)!));

  const currentDate = new Date().toISOString().split('T')[0];
  const current = toPoint('HEAD', currentDate);
  // Overwrite with the actual current snapshots (toPoint looked up by
  // commit hash "HEAD" which won't be in the maps — use the real current values).
  current.max_cyclomatic = complexity?.current.max_cyclomatic ?? null;
  current.avg_cyclomatic = complexity?.current.avg_cyclomatic ?? null;
  current.ca = coupling?.current.ca ?? null;
  current.ce = coupling?.current.ce ?? null;
  current.instability = coupling?.current.instability ?? null;
  {
    const complexityTerm =
      current.max_cyclomatic !== null ? clampNormalize(current.max_cyclomatic, 20) : 0;
    const instabilityTerm = current.instability ?? 0;
    const complexityWeight = current.max_cyclomatic !== null ? 0.6 : 0;
    const instabilityWeight = current.instability !== null ? 0.4 : 0;
    const totalWeight = complexityWeight + instabilityWeight;
    current.risk_score =
      totalWeight > 0
        ? round(
            (complexityWeight * complexityTerm + instabilityWeight * instabilityTerm) / totalWeight,
          )
        : null;
  }

  const churnEntries = getChurnRate(cwd, { sinceDays, filePattern: filePath, limit: 500 });
  const churnEntry = churnEntries.find((e) => e.file === filePath);

  let trend: 'improving' | 'stable' | 'degrading' = 'stable';
  const oldestResolved = [...historical].reverse().find((p) => p.risk_score !== null);
  if (oldestResolved && current.risk_score !== null && oldestResolved.risk_score !== null) {
    const delta = current.risk_score - oldestResolved.risk_score;
    if (delta >= 0.1) trend = 'degrading';
    else if (delta <= -0.1) trend = 'improving';
  }

  return {
    file: filePath,
    since_days: sinceDays,
    current,
    historical,
    churn: {
      commits: churnEntry?.commits ?? 0,
      unique_authors: churnEntry?.unique_authors ?? 0,
      churn_per_week: churnEntry?.churn_per_week ?? 0,
      assessment: churnEntry?.assessment ?? null,
    },
    trend,
    _methodology: METHODOLOGY,
  };
}
