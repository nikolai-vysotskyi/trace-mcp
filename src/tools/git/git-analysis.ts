/**
 * Git-based code analysis:
 * - Churn rate per file (commits, authors, frequency)
 * - Hotspots (complexity × churn — Adam Tornhill / CodeScene methodology)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from '../../db/store.js';
import { logger } from '../../logger.js';
import { safeGitEnv } from '../../utils/git-env.js';
import {
  type ConfidenceLevel,
  classifyConfidence,
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

export interface HotspotEntry {
  file: string;
  /** Max cyclomatic complexity among symbols in this file */
  max_cyclomatic: number;
  /** Number of commits in the analysis window (null when file is outside git history) */
  commits: number | null;
  /** hotspot_score = max_cyclomatic × log(1 + commits) (or max_cyclomatic when commits is null) */
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

export interface GitRoot {
  /** Absolute path to the git working tree root */
  dir: string;
  /** Relative path from cwd to dir (empty string if dir === cwd, e.g. "subrepo" if child) */
  relToCwd: string;
  /** Whether dir is an ancestor of cwd (cwd is inside a subfolder of dir) */
  isAncestor: boolean;
}

const IGNORED_GIT_SCAN_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.cache',
  '.next',
  '.turbo',
  'vendor',
  'target',
]);

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
    'heuristic triage ranking, not a validated risk metric — calibration (scripts/calibrate-health-metrics.mjs) shows churn correlates only moderately (Spearman ~0.3) with where bugs are later fixed',
    'requires git history; falls back to complexity-only ranking when git is unavailable',
    'max-per-file complexity is dominated by the single hottest function',
    'analysis window is fixed by sinceDays — files outside the window are ignored',
    'rename detection follows git defaults; aggressive renames may split history',
  ],
};

// ════════════════════════════════════════════════════════════════════════
// GIT HELPERS
// ════════════════════════════════════════════════════════════════════════

export interface GitLogEntry {
  file: string;
  commits: number;
  authors: Set<string>;
  firstDate: Date;
  lastDate: Date;
}

/**
 * Resolve all relevant git roots for a given project directory:
 * 1. Checks upwards via `git rev-parse --show-toplevel` (handles standard repos and subdirectories).
 * 2. Scans nested directories up to depth 2 for `.git` (handles umbrella repos with nested projects/submodules).
 */
export function resolveGitRoots(cwd: string): GitRoot[] {
  const roots: GitRoot[] = [];
  const normalizedCwd = path.resolve(cwd);

  // 1. Upwards check
  try {
    const rawTop = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: normalizedCwd,
      stdio: 'pipe',
      timeout: 5000,
      env: safeGitEnv(),
    })
      .toString('utf-8')
      .trim();

    if (rawTop) {
      // In tests, mockExecFileSync may return 'true' or a relative path
      const top = path.isAbsolute(rawTop) ? path.resolve(rawTop) : normalizedCwd;
      const isAncestor = top !== normalizedCwd && normalizedCwd.startsWith(top + path.sep);
      roots.push({
        dir: top,
        relToCwd: path.relative(normalizedCwd, top),
        isAncestor,
      });
    }
  } catch {
    // cwd is not inside a git repo from rev-parse upwards
  }

  // 2. Downwards check for nested git repositories (depth 1 & 2)
  function checkDirForGit(dirPath: string): string | null {
    try {
      const gitPath = path.join(dirPath, '.git');
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        const raw = execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: dirPath,
          stdio: 'pipe',
          timeout: 5000,
          env: safeGitEnv(),
        })
          .toString('utf-8')
          .trim();
        return raw && path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(dirPath);
      }
    } catch {
      // Not a git repository
    }
    return null;
  }

  try {
    const level1 = fs.readdirSync(normalizedCwd, { withFileTypes: true });
    for (const entry1 of level1) {
      if (
        !entry1.isDirectory() ||
        entry1.name.startsWith('.') ||
        IGNORED_GIT_SCAN_DIRS.has(entry1.name)
      ) {
        continue;
      }
      const path1 = path.join(normalizedCwd, entry1.name);
      const gitTop1 = checkDirForGit(path1);
      if (gitTop1) {
        if (!roots.some((r) => r.dir === gitTop1)) {
          roots.push({
            dir: gitTop1,
            relToCwd: path.relative(normalizedCwd, gitTop1),
            isAncestor: false,
          });
        }
        // Do not recurse into an already discovered git root
        continue;
      }

      // Check depth 2
      try {
        const level2 = fs.readdirSync(path1, { withFileTypes: true });
        for (const entry2 of level2) {
          if (
            !entry2.isDirectory() ||
            entry2.name.startsWith('.') ||
            IGNORED_GIT_SCAN_DIRS.has(entry2.name)
          ) {
            continue;
          }
          const path2 = path.join(path1, entry2.name);
          const gitTop2 = checkDirForGit(path2);
          if (gitTop2) {
            if (!roots.some((r) => r.dir === gitTop2)) {
              roots.push({
                dir: gitTop2,
                relToCwd: path.relative(normalizedCwd, gitTop2),
                isAncestor: false,
              });
            }
          }
        }
      } catch {
        // Ignore depth 2 read errors
      }
    }
  } catch {
    // Ignore cwd read errors
  }

  return roots;
}

/**
 * Map a file path returned by git log in `root.dir` back to a relative path from `cwd`.
 * Returns null if the file lies outside `cwd` (for example, in an ancestor repo outside the subtree).
 */
export function mapRepoPathToCwd(root: GitRoot, repoRelPath: string, cwd: string): string | null {
  const normalizedCwd = path.resolve(cwd);
  const normalizedDir = path.resolve(root.dir);
  const normalizedFile = repoRelPath.replace(/\\/g, '/');

  if (normalizedDir === normalizedCwd) {
    return normalizedFile;
  }
  if (root.isAncestor) {
    let prefix = path.relative(normalizedDir, normalizedCwd).replace(/\\/g, '/');
    if (!prefix.endsWith('/')) {
      prefix += '/';
    }
    if (normalizedFile.startsWith(prefix)) {
      return normalizedFile.slice(prefix.length);
    }
    return null;
  }
  // Child / nested repo: prefix with child folder path relative to cwd
  const prefix = path.relative(normalizedCwd, normalizedDir).replace(/\\/g, '/');
  return prefix ? `${prefix}/${normalizedFile}` : normalizedFile;
}

/**
 * Check if a file is covered by any resolved git repository root.
 */
export function isFileCoveredByGit(file: string, roots: GitRoot[], cwd: string): boolean {
  if (roots.length === 0) return false;
  const normalizedCwd = path.resolve(cwd);
  const normalizedFile = file.replace(/\\/g, '/');

  for (const root of roots) {
    const normalizedDir = path.resolve(root.dir);
    if (normalizedDir === normalizedCwd || root.isAncestor) {
      return true;
    }
    const prefix = path.relative(normalizedCwd, normalizedDir).replace(/\\/g, '/');
    if (prefix && (normalizedFile === prefix || normalizedFile.startsWith(`${prefix}/`))) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the project root is inside a git repository or contains nested git repositories.
 */
export function isGitRepo(cwd: string): boolean {
  return resolveGitRoots(cwd).length > 0;
}

/**
 * Collect per-file git log data across all resolved git roots.
 */
export function collectGitLogs(cwd: string, sinceDays?: number): Map<string, GitLogEntry> {
  const roots = resolveGitRoots(cwd);
  if (roots.length === 0) {
    return new Map();
  }

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

  const fileStats = new Map<string, GitLogEntry>();

  for (const root of roots) {
    let output: string;
    try {
      output = execFileSync('git', args, {
        cwd: root.dir,
        stdio: 'pipe',
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        timeout: 30_000,
        env: safeGitEnv(),
      }).toString('utf-8');
    } catch (e) {
      logger.warn({ error: e, root: root.dir }, 'git log failed');
      continue;
    }

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

      const mapped = mapRepoPathToCwd(root, trimmed, cwd);
      if (!mapped) continue;

      const existing = fileStats.get(mapped);
      if (existing) {
        existing.commits++;
        existing.authors.add(currentAuthor);
        if (currentDate < existing.firstDate) existing.firstDate = currentDate;
        if (currentDate > existing.lastDate) existing.lastDate = currentDate;
      } else {
        fileStats.set(mapped, {
          file: mapped,
          commits: 1,
          authors: new Set([currentAuthor]),
          firstDate: currentDate,
          lastDate: currentDate,
        });
      }
    }
  }

  return fileStats;
}

/**
 * Get per-file git log data: commit count, authors, date range.
 */
function getGitFileStats(cwd: string, sinceDays?: number): Map<string, GitLogEntry> {
  return collectGitLogs(cwd, sinceDays);
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
  const entries: ChurnEntry[] = [];

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
  const roots = resolveGitRoots(cwd);

  if (roots.length === 0) {
    // Fallback: complexity-only ranking when git unavailable
    return getComplexityOnlyHotspots(store, limit, minCyclomatic);
  }

  const gitStats = getGitFileStats(cwd, sinceDays);

  // Get max cyclomatic per file from indexed symbols
  const fileComplexity = getMaxCyclomaticPerFile(store);

  const entries: HotspotEntry[] = [];

  for (const [file, maxCyclomatic] of fileComplexity) {
    if (maxCyclomatic < minCyclomatic) continue;

    const covered = isFileCoveredByGit(file, roots, cwd);
    let commits: number | null = null;
    let score: number;
    let signalsFired: number;
    let assessment: HotspotEntry['assessment'];
    let confidenceLevel: ConfidenceLevel;

    if (!covered) {
      // File is outside all git repositories
      score = maxCyclomatic;
      assessment = score <= 3 ? 'low' : score <= 10 ? 'medium' : 'high';
      signalsFired = maxCyclomatic > HOTSPOT_COMPLEXITY_FIRE ? 1 : 0;
      confidenceLevel = 'low';
    } else {
      const git = gitStats.get(file);
      commits = git?.commits ?? 0;
      score = Math.round(maxCyclomatic * Math.log(1 + commits) * 100) / 100;

      if (score <= 0) continue;

      if (score <= 3) assessment = 'low';
      else if (score <= 10) assessment = 'medium';
      else assessment = 'high';

      signalsFired =
        (maxCyclomatic > HOTSPOT_COMPLEXITY_FIRE ? 1 : 0) + (commits > HOTSPOT_CHURN_FIRE ? 1 : 0);
      confidenceLevel = classifyConfidence(signalsFired, 2);
    }

    entries.push({
      file,
      max_cyclomatic: maxCyclomatic,
      commits,
      score,
      assessment,
      confidence_level: confidenceLevel,
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
      commits: null,
      score: maxCyclomatic, // score = complexity alone
      assessment: maxCyclomatic <= 3 ? 'low' : maxCyclomatic <= 10 ? 'medium' : 'high',
      confidence_level: 'low',
      signals_fired: maxCyclomatic > HOTSPOT_COMPLEXITY_FIRE ? 1 : 0,
    });
  }

  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, limit);
}
