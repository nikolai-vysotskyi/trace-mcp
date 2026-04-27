/**
 * Git-based code analysis:
 * - Churn rate per file (commits, authors, frequency)
 * - Hotspots (complexity × churn — Adam Tornhill / CodeScene methodology)
 */

import { execFileSync } from 'node:child_process';
import type { Store } from '../../db/store.js';
import { logger } from '../../logger.js';
import {
  classifyConfidence,
  type ConfidenceLevel,
  type Methodology,
} from '../shared/confidence.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface ChurnEntry {
  file: string;
  commits: number;
  unique_authors: number;
  first_seen: string;
  last_modified: string;
  /** Average commits per week over the file's lifetime */
  churn_per_week: number;
  assessment: 'stable' | 'active' | 'volatile';
}

interface HotspotEntry {
  file: string;
  /** Max cyclomatic complexity among symbols in this file */
  max_cyclomatic: number;
  /** Number of commits in the analysis window */
  commits: number;
  /** hotspot_score = max_cyclomatic × log(1 + commits) */
  score: number;
  assessment: 'low' | 'medium' | 'high';
  /**
   * Categorical confidence in the hotspot signal: counts how many of the two
   * independent inputs (complexity, churn) actually fired strongly. Distinct
   * from `assessment`, which buckets the raw score.
   */
  confidence_level: ConfidenceLevel;
  /** Number of independent signals that fired (0..2). */
  signals_fired: number;
}

/** A signal "fires" when its raw value crosses this threshold. */
const HOTSPOT_COMPLEXITY_FIRE = 10; // matches the high-complexity boundary used by assessment
const HOTSPOT_CHURN_FIRE = 5; // > 5 commits in the analysis window

export const HOTSPOT_METHODOLOGY: Methodology = {
  algorithm: 'tornhill_complexity_churn_hotspots',
  signals: [
    'complexity: max cyclomatic complexity among symbols in the file',
    'churn: number of git commits touching the file in the analysis window',
  ],
  confidence_formula:
    'score = max_cyclomatic × log(1 + commits). assessment buckets the score (≤3=low, ≤10=medium, >10=high). confidence_level counts signals that fired strongly (complexity > 10, commits > 5): 0=low, 1=medium, 2=multi_signal.',
  limitations: [
    'requires git history; falls back to complexity-only ranking when git is unavailable',
    'max-per-file complexity is dominated by the single hottest function',
    'analysis window is fixed by sinceDays — files outside the window are ignored',
    'rename detection follows git defaults; aggressive renames may split history',
  ],
};

// ════════════════════════════════════════════════════════════════════════
// GIT HELPERS
// ════════════════════════════════════════════════════════════════════════

interface GitLogEntry {
  file: string;
  commits: number;
  authors: Set<string>;
  firstDate: Date;
  lastDate: Date;
}

/**
 * Check if the project root is inside a git repository.
 */
export function isGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: 'pipe',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get per-file git log data: commit count, authors, date range.
 * Uses a single `git log` call with --name-only for efficiency.
 */
function getGitFileStats(cwd: string, sinceDays?: number): Map<string, GitLogEntry> {
  const args = [
    'log',
    '--pretty=format:__COMMIT__%H|%aI|%aN',
    '--name-only',
    '--no-merges',
    '--diff-filter=ACDMR',
  ];
  if (sinceDays !== undefined) {
    args.push(`--since=${sinceDays} days ago`);
  }

  let output: string;
  try {
    output = execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      timeout: 30_000,
    }).toString('utf-8');
  } catch (e) {
    logger.warn({ error: e }, 'git log failed');
    return new Map();
  }

  const fileStats = new Map<string, GitLogEntry>();
  let currentDate: Date | null = null;
  let currentAuthor: string | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      const parts = line.slice('__COMMIT__'.length).split('|');
      // parts: [hash, isoDate, authorName]
      currentDate = new Date(parts[1]);
      currentAuthor = parts[2];
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || !currentDate || !currentAuthor) continue;

    const existing = fileStats.get(trimmed);
    if (existing) {
      existing.commits++;
      existing.authors.add(currentAuthor);
      if (currentDate < existing.firstDate) existing.firstDate = currentDate;
      if (currentDate > existing.lastDate) existing.lastDate = currentDate;
    } else {
      fileStats.set(trimmed, {
        file: trimmed,
        commits: 1,
        authors: new Set([currentAuthor]),
        firstDate: currentDate,
        lastDate: currentDate,
      });
    }
  }

  return fileStats;
}

// ════════════════════════════════════════════════════════════════════════
// 1. CHURN RATE
// ════════════════════════════════════════════════════════════════════════

export function getChurnRate(
  cwd: string,
  options: { sinceDays?: number; limit?: number; filePattern?: string } = {},
): ChurnEntry[] {
  const { sinceDays, limit = 50, filePattern } = options;

  if (!isGitRepo(cwd)) {
    return [];
  }

  const stats = getGitFileStats(cwd, sinceDays);
  let entries: ChurnEntry[] = [];

  for (const [file, data] of stats) {
    if (filePattern && !file.includes(filePattern)) continue;

    const lifespanMs = data.lastDate.getTime() - data.firstDate.getTime();
    const lifespanWeeks = Math.max(lifespanMs / (7 * 24 * 60 * 60 * 1000), 1);
    const churnPerWeek = Math.round((data.commits / lifespanWeeks) * 100) / 100;

    let assessment: ChurnEntry['assessment'];
    if (churnPerWeek <= 1) assessment = 'stable';
    else if (churnPerWeek <= 3) assessment = 'active';
    else assessment = 'volatile';

    entries.push({
      file,
      commits: data.commits,
      unique_authors: data.authors.size,
      first_seen: data.firstDate.toISOString().split('T')[0],
      last_modified: data.lastDate.toISOString().split('T')[0],
      churn_per_week: churnPerWeek,
      assessment,
    });
  }

  entries.sort((a, b) => b.commits - a.commits);
  return entries.slice(0, limit);
}

// ════════════════════════════════════════════════════════════════════════
// 2. HOTSPOTS (complexity × churn)
// ════════════════════════════════════════════════════════════════════════

export function getHotspots(
  store: Store,
  cwd: string,
  options: { sinceDays?: number; limit?: number; minCyclomatic?: number } = {},
): HotspotEntry[] {
  const { sinceDays = 90, limit = 20, minCyclomatic = 3 } = options;

  if (!isGitRepo(cwd)) {
    // Fallback: complexity-only ranking when git unavailable
    return getComplexityOnlyHotspots(store, limit, minCyclomatic);
  }

  const gitStats = getGitFileStats(cwd, sinceDays);

  // Get max cyclomatic per file from indexed symbols
  const fileComplexity = getMaxCyclomaticPerFile(store);

  const entries: HotspotEntry[] = [];

  for (const [file, maxCyclomatic] of fileComplexity) {
    if (maxCyclomatic < minCyclomatic) continue;

    const git = gitStats.get(file);
    const commits = git?.commits ?? 0;
    const score = Math.round(maxCyclomatic * Math.log(1 + commits) * 100) / 100;

    if (score <= 0) continue;

    let assessment: HotspotEntry['assessment'];
    if (score <= 3) assessment = 'low';
    else if (score <= 10) assessment = 'medium';
    else assessment = 'high';

    const signalsFired =
      (maxCyclomatic > HOTSPOT_COMPLEXITY_FIRE ? 1 : 0) + (commits > HOTSPOT_CHURN_FIRE ? 1 : 0);

    entries.push({
      file,
      max_cyclomatic: maxCyclomatic,
      commits,
      score,
      assessment,
      confidence_level: classifyConfidence(signalsFired, 2),
      signals_fired: signalsFired,
    });
  }

  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, limit);
}

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

/** Get the maximum cyclomatic complexity per file from the symbols table. */
function getMaxCyclomaticPerFile(store: Store): Map<string, number> {
  const rows = store.db
    .prepare(`
    SELECT f.path, MAX(s.cyclomatic) as max_cyclomatic
    FROM symbols s
    JOIN files f ON s.file_id = f.id
    WHERE s.cyclomatic IS NOT NULL
    GROUP BY f.path
  `)
    .all() as Array<{ path: string; max_cyclomatic: number }>;

  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.path, row.max_cyclomatic);
  }
  return result;
}

/** Fallback when git is unavailable — rank by complexity alone. */
function getComplexityOnlyHotspots(
  store: Store,
  limit: number,
  minCyclomatic: number,
): HotspotEntry[] {
  const fileComplexity = getMaxCyclomaticPerFile(store);
  const entries: HotspotEntry[] = [];

  for (const [file, maxCyclomatic] of fileComplexity) {
    if (maxCyclomatic < minCyclomatic) continue;
    // Only one signal available (no git) — confidence is capped at low.
    entries.push({
      file,
      max_cyclomatic: maxCyclomatic,
      commits: 0,
      score: maxCyclomatic, // score = complexity alone
      assessment: maxCyclomatic <= 3 ? 'low' : maxCyclomatic <= 10 ? 'medium' : 'high',
      confidence_level: 'low',
      signals_fired: maxCyclomatic > HOTSPOT_COMPLEXITY_FIRE ? 1 : 0,
    });
  }

  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, limit);
}
