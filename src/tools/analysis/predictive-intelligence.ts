/**
 * Predictive Intelligence:
 * - Bug prediction (multi-signal scoring)
 * - Architectural drift detection (co-change anomalies, shotgun surgery)
 * - Tech debt scoring (per-module A–F grade)
 * - Change risk assessment (pre-change risk level)
 * - Health trends (time-series metrics)
 */

import { execFileSync } from 'node:child_process';
import type { Store } from '../../db/store.js';
import { ok, err, type TraceMcpResult } from '../../errors.js';
import { validationError } from '../../errors.js';
import { logger } from '../../logger.js';
import { isGitRepo } from '../git/git-analysis.js';
import {
  buildFileGraph,
  getCouplingMetrics,
  getPageRank,
  type CouplingResult,
  type PageRankResult,
} from './graph-analysis.js';
import {
  classifyConfidence,
  type ConfidenceLevel,
  type Methodology,
} from '../shared/confidence.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface BugPredictionWeights {
  churn: number;
  fix_ratio: number;
  complexity: number;
  coupling: number;
  pagerank: number;
  authors: number;
}

interface BugPrediction {
  file: string;
  score: number;
  risk: 'low' | 'medium' | 'high' | 'critical';
  confidence_level: ConfidenceLevel;
  signals_fired: number;
  factors: Array<{
    signal: string;
    raw_value: number;
    normalized: number;
    weight: number;
    contribution: number;
  }>;
}

interface BugPredictionResult {
  predictions: BugPrediction[];
  total_files_analyzed: number;
  snapshot_id: number | null;
  cached: boolean;
  _methodology: Methodology;
}

/**
 * A bug-prediction signal "fires" if its normalized value clears this threshold.
 * 0.5 = signal is in the upper half of its possible range across the project.
 * The count of fired signals drives confidence_level (independent of weighted score).
 */
const BUG_SIGNAL_FIRE_THRESHOLD = 0.5;

const BUG_PREDICTION_METHODOLOGY: Methodology = {
  algorithm: 'multi_signal_weighted_bug_prediction',
  signals: [
    'churn: rank-percentile of weekly commit frequency over the analysis window',
    'fix_ratio: share of commits whose message indicates a bug fix',
    'complexity: max cyclomatic complexity in the file, clamp-normalized to 20',
    'coupling: instability metric I = Ce / (Ca + Ce) from import graph',
    'pagerank: rank-percentile of file PageRank in the import graph',
    'authors: distinct author count over the analysis window, clamp-normalized to 10',
  ],
  confidence_formula:
    'score = Σ(weight × normalized_signal). confidence_level counts signals with normalized > 0.5: 1=low, 2=medium, 3=high, ≥4=multi_signal. risk is bucketed from raw score (low<0.3, medium<0.5, high<0.75, critical≥0.75).',
  limitations: [
    'fix_ratio depends on commit message conventions ("fix:", "bug:", etc.)',
    'rank-percentile means score is relative to the rest of the project, not absolute',
    'newly added files have churn ≈ 0 and may be under-reported',
    'requires git history for churn / fix_ratio / authors signals',
    'complexity uses max-per-file, so a single hot function can dominate',
  ],
};

interface CoChangeAnomaly {
  file_a: string;
  file_b: string;
  co_change_count: number;
  confidence: number;
  module_a: string;
  module_b: string;
}

interface ShotgunEntry {
  file: string;
  shotgun_commits: number;
  total_commits: number;
  ratio: number;
}

interface DriftReport {
  co_change_anomalies: CoChangeAnomaly[];
  shotgun_surgery: ShotgunEntry[];
  summary: {
    total_anomalies: number;
    shotgun_hotspots: number;
  };
}

interface TechDebtModule {
  module: string;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: { complexity: number; coupling: number; test_gap: number; churn: number };
  file_count: number;
  recommendations: Array<{ action: string; target: string; priority: 'low' | 'medium' | 'high' }>;
}

export interface TechDebtResult {
  modules: TechDebtModule[];
  project_score: number;
  project_grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

interface ChangeRiskResult {
  target: { file: string; symbol_id?: string };
  risk_score: number;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  factors: Array<{
    signal: string;
    value: number;
    weight: number;
    contribution: number;
    detail: string;
  }>;
  mitigations: string[];
  blast_radius: { files: number; symbols: number };
}

interface HealthTrendPoint {
  date: string;
  bug_score: number | null;
  complexity_avg: number | null;
  coupling: number | null;
  churn: number | null;
  test_coverage: number | null;
}

interface HealthTrendResult {
  target: string;
  data_points: HealthTrendPoint[];
  trend: 'improving' | 'stable' | 'degrading';
}

// ════════════════════════════════════════════════════════════════════════
// CONFIGURATION DEFAULTS
// ════════════════════════════════════════════════════════════════════════

const DEFAULT_BUG_WEIGHTS: BugPredictionWeights = {
  churn: 0.2,
  fix_ratio: 0.2,
  complexity: 0.2,
  coupling: 0.15,
  pagerank: 0.1,
  authors: 0.15,
};

const DEFAULT_DEBT_WEIGHTS = {
  complexity: 0.3,
  coupling: 0.25,
  test_gap: 0.25,
  churn: 0.2,
};

const DEFAULT_RISK_WEIGHTS = {
  blast_radius: 0.25,
  complexity: 0.2,
  churn: 0.2,
  test_gap: 0.2,
  coupling: 0.15,
};

// ════════════════════════════════════════════════════════════════════════
// GIT HELPERS
// ════════════════════════════════════════════════════════════════════════

interface GitFileInfo {
  commits: number;
  authors: number;
  churnPerWeek: number;
  fixCommits: number;
  fixRatio: number;
}

/**
 * Get per-file git stats including fix-commit classification.
 * Uses a single `git log` call for efficiency.
 */
function getGitFileStatsWithFixes(cwd: string, sinceDays: number): Map<string, GitFileInfo> {
  const args = [
    'log',
    '--pretty=format:__COMMIT__%H|%aI|%aN|%s',
    '--name-only',
    '--no-merges',
    '--diff-filter=ACDMR',
    `--since=${sinceDays} days ago`,
  ];

  let output: string;
  try {
    output = execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    }).toString('utf-8');
  } catch (e) {
    logger.warn({ error: e }, 'git log failed for predictive intelligence');
    return new Map();
  }

  const FIX_PATTERN = /\b(fix|bug|patch|hotfix|repair|resolve|correct)\b/i;

  const fileData = new Map<
    string,
    {
      commits: number;
      authors: Set<string>;
      firstDate: Date;
      lastDate: Date;
      fixCommits: number;
    }
  >();

  let currentDate: Date | null = null;
  let currentAuthor: string | null = null;
  let currentIsFix = false;

  for (const line of output.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      const parts = line.slice('__COMMIT__'.length).split('|');
      currentDate = new Date(parts[1]);
      currentAuthor = parts[2];
      currentIsFix = FIX_PATTERN.test(parts[3] ?? '');
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || !currentDate || !currentAuthor) continue;

    const existing = fileData.get(trimmed);
    if (existing) {
      existing.commits++;
      existing.authors.add(currentAuthor);
      if (currentIsFix) existing.fixCommits++;
      if (currentDate < existing.firstDate) existing.firstDate = currentDate;
      if (currentDate > existing.lastDate) existing.lastDate = currentDate;
    } else {
      fileData.set(trimmed, {
        commits: 1,
        authors: new Set([currentAuthor]),
        firstDate: currentDate,
        lastDate: currentDate,
        fixCommits: currentIsFix ? 1 : 0,
      });
    }
  }

  const result = new Map<string, GitFileInfo>();
  for (const [file, data] of fileData) {
    const lifespanMs = data.lastDate.getTime() - data.firstDate.getTime();
    const lifespanWeeks = Math.max(lifespanMs / (7 * 24 * 60 * 60 * 1000), 1);
    const churnPerWeek = data.commits / lifespanWeeks;
    result.set(file, {
      commits: data.commits,
      authors: data.authors.size,
      churnPerWeek,
      fixCommits: data.fixCommits,
      fixRatio: data.commits > 0 ? data.fixCommits / data.commits : 0,
    });
  }

  return result;
}

/**
 * Get co-change commit groups for drift detection.
 * Returns array of [commitHash, Set<filePath>].
 */
function getCommitFileGroups(cwd: string, sinceDays: number): Array<{ files: Set<string> }> {
  const args = [
    'log',
    '--pretty=format:__COMMIT__%H',
    '--name-only',
    '--no-merges',
    '--diff-filter=ACDMR',
    `--since=${sinceDays} days ago`,
  ];

  let output: string;
  try {
    output = execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    }).toString('utf-8');
  } catch {
    return [];
  }

  const groups: Array<{ files: Set<string> }> = [];
  let currentFiles: Set<string> | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      if (currentFiles && currentFiles.size > 0) {
        groups.push({ files: currentFiles });
      }
      currentFiles = new Set();
      continue;
    }
    const trimmed = line.trim();
    if (trimmed && currentFiles) {
      currentFiles.add(trimmed);
    }
  }
  if (currentFiles && currentFiles.size > 0) {
    groups.push({ files: currentFiles });
  }

  return groups;
}

// ════════════════════════════════════════════════════════════════════════
// NORMALIZATION HELPERS
// ════════════════════════════════════════════════════════════════════════

/** Rank-based percentile normalization: returns a Map<key, 0..1> */
function rankPercentile<K>(values: Map<K, number>): Map<K, number> {
  const entries = [...values.entries()].sort((a, b) => a[1] - b[1]);
  const n = entries.length;
  const result = new Map<K, number>();
  for (let i = 0; i < n; i++) {
    result.set(entries[i][0], n > 1 ? i / (n - 1) : 0.5);
  }
  return result;
}

/** Clamp-based normalization: min(1, value / ceiling) */
function clampNormalize(value: number, ceiling: number): number {
  return Math.min(1, value / ceiling);
}

function riskLevel(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score < 0.3) return 'low';
  if (score < 0.5) return 'medium';
  if (score < 0.75) return 'high';
  return 'critical';
}

function debtGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score < 0.2) return 'A';
  if (score < 0.4) return 'B';
  if (score < 0.6) return 'C';
  if (score < 0.8) return 'D';
  return 'F';
}

/** Get module path from file path at given depth */
function getModule(filePath: string, depth: number): string {
  const parts = filePath.split('/');
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/') || filePath;
}

// ════════════════════════════════════════════════════════════════════════
// 1. BUG PREDICTION
// ════════════════════════════════════════════════════════════════════════

export function predictBugs(
  store: Store,
  cwd: string,
  options: {
    limit?: number;
    minScore?: number;
    filePattern?: string;
    sinceDays?: number;
    weights?: Partial<BugPredictionWeights>;
    refresh?: boolean;
    cacheTtlMinutes?: number;
  } = {},
): TraceMcpResult<BugPredictionResult> {
  const { limit = 50, minScore = 0, filePattern, sinceDays = 180 } = options;
  const w = { ...DEFAULT_BUG_WEIGHTS, ...options.weights };

  // Check cache
  if (!options.refresh) {
    const ttlMs = (options.cacheTtlMinutes ?? 60) * 60 * 1000;
    const cached = getCachedBugPredictions(store, limit, minScore, filePattern, ttlMs);
    if (cached) return ok(cached);
  }

  // Gather all signals — build file graph once, share across analyses
  const gitStats = isGitRepo(cwd)
    ? getGitFileStatsWithFixes(cwd, sinceDays)
    : new Map<string, GitFileInfo>();
  const fileGraph = buildFileGraph(store);
  const couplingResults = getCouplingMetrics(store, fileGraph);
  const pagerankResults = getPageRank(store, { prebuiltGraph: fileGraph });

  // Build lookup maps
  const couplingMap = new Map<string, CouplingResult>();
  for (const c of couplingResults) couplingMap.set(c.file, c);

  const pagerankMap = new Map<string, PageRankResult>();
  for (const p of pagerankResults) pagerankMap.set(p.file, p);

  // Get max cyclomatic per file
  const complexityRows = store.db
    .prepare(`
    SELECT f.path, MAX(s.cyclomatic) as max_cyclomatic
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE s.cyclomatic IS NOT NULL
    GROUP BY f.path
  `)
    .all() as Array<{ path: string; max_cyclomatic: number }>;
  const complexityMap = new Map<string, number>();
  for (const row of complexityRows) complexityMap.set(row.path, row.max_cyclomatic);

  // Collect all indexed files
  const allFiles = store.getAllFiles();
  const fileSet = new Set<string>();
  for (const f of allFiles) {
    if (filePattern && !f.path.includes(filePattern)) continue;
    fileSet.add(f.path);
  }

  // Build raw signal maps for rank normalization
  const churnRaw = new Map<string, number>();
  const pagerankRaw = new Map<string, number>();
  for (const file of fileSet) {
    churnRaw.set(file, gitStats.get(file)?.churnPerWeek ?? 0);
    pagerankRaw.set(file, pagerankMap.get(file)?.score ?? 0);
  }

  const churnRanks = rankPercentile(churnRaw);
  const pagerankRanks = rankPercentile(pagerankRaw);

  // Score each file
  const predictions: BugPrediction[] = [];
  for (const file of fileSet) {
    const git = gitStats.get(file);
    const coupling = couplingMap.get(file);

    const sChurn = churnRanks.get(file) ?? 0;
    const sFixRatio = git?.fixRatio ?? 0;
    const sComplexity = clampNormalize(complexityMap.get(file) ?? 0, 20);
    const sCoupling = coupling?.instability ?? 0;
    const sPagerank = pagerankRanks.get(file) ?? 0;
    const sAuthors = clampNormalize(git?.authors ?? 0, 10);

    const score =
      w.churn * sChurn +
      w.fix_ratio * sFixRatio +
      w.complexity * sComplexity +
      w.coupling * sCoupling +
      w.pagerank * sPagerank +
      w.authors * sAuthors;

    if (score < minScore) continue;

    const signalsFired = [sChurn, sFixRatio, sComplexity, sCoupling, sPagerank, sAuthors].filter(
      (v) => v > BUG_SIGNAL_FIRE_THRESHOLD,
    ).length;

    predictions.push({
      file,
      score: Math.round(score * 1000) / 1000,
      risk: riskLevel(score),
      confidence_level: classifyConfidence(signalsFired, 6),
      signals_fired: signalsFired,
      factors: [
        {
          signal: 'churn',
          raw_value: round(git?.churnPerWeek ?? 0),
          normalized: round(sChurn),
          weight: w.churn,
          contribution: round(w.churn * sChurn),
        },
        {
          signal: 'fix_ratio',
          raw_value: round(git?.fixRatio ?? 0),
          normalized: round(sFixRatio),
          weight: w.fix_ratio,
          contribution: round(w.fix_ratio * sFixRatio),
        },
        {
          signal: 'complexity',
          raw_value: complexityMap.get(file) ?? 0,
          normalized: round(sComplexity),
          weight: w.complexity,
          contribution: round(w.complexity * sComplexity),
        },
        {
          signal: 'coupling',
          raw_value: round(coupling?.instability ?? 0),
          normalized: round(sCoupling),
          weight: w.coupling,
          contribution: round(w.coupling * sCoupling),
        },
        {
          signal: 'pagerank',
          raw_value: round(pagerankMap.get(file)?.score ?? 0),
          normalized: round(sPagerank),
          weight: w.pagerank,
          contribution: round(w.pagerank * sPagerank),
        },
        {
          signal: 'authors',
          raw_value: git?.authors ?? 0,
          normalized: round(sAuthors),
          weight: w.authors,
          contribution: round(w.authors * sAuthors),
        },
      ],
    });
  }

  predictions.sort((a, b) => b.score - a.score);

  // Cache results
  const snapshotId = saveBugPredictionCache(store, predictions, cwd);

  const result = predictions.slice(0, limit);
  return ok({
    predictions: result,
    total_files_analyzed: fileSet.size,
    snapshot_id: snapshotId,
    cached: false,
    _methodology: BUG_PREDICTION_METHODOLOGY,
  });
}

// ════════════════════════════════════════════════════════════════════════
// 2. ARCHITECTURAL DRIFT DETECTION
// ════════════════════════════════════════════════════════════════════════

export function detectDrift(
  store: Store,
  cwd: string,
  options: {
    sinceDays?: number;
    minConfidence?: number;
    moduleDepth?: number;
    refresh?: boolean;
  } = {},
): TraceMcpResult<DriftReport> {
  const { sinceDays = 180, minConfidence = 0.3, moduleDepth = 2 } = options;

  if (!isGitRepo(cwd)) {
    return ok({
      co_change_anomalies: [],
      shotgun_surgery: [],
      summary: { total_anomalies: 0, shotgun_hotspots: 0 },
    });
  }

  const commitGroups = getCommitFileGroups(cwd, sinceDays);

  // Build co-change matrix
  const coChangeCount = new Map<string, number>(); // "fileA|fileB" -> count
  const fileCommitCount = new Map<string, number>();
  const _fileModuleMap = new Map<string, Set<string>>(); // file -> set of modules touched per commit

  // Track shotgun commits per file
  const fileShotgunCount = new Map<string, number>();
  const fileTotalCount = new Map<string, number>();

  for (const group of commitGroups) {
    const files = [...group.files];
    const modulesTouched = new Set<string>();

    for (const file of files) {
      fileCommitCount.set(file, (fileCommitCount.get(file) ?? 0) + 1);
      fileTotalCount.set(file, (fileTotalCount.get(file) ?? 0) + 1);
      modulesTouched.add(getModule(file, moduleDepth));
    }

    // Shotgun: commit touches 3+ distinct modules
    const isShotgun = modulesTouched.size >= 3;
    if (isShotgun) {
      for (const file of files) {
        fileShotgunCount.set(file, (fileShotgunCount.get(file) ?? 0) + 1);
      }
    }

    // Build co-change pairs (only for files in different modules)
    // Cap at 50 files per commit to avoid O(n²) blowup on mega-commits
    const cappedFiles = files.length > 50 ? files.slice(0, 50) : files;
    for (let i = 0; i < cappedFiles.length; i++) {
      for (let j = i + 1; j < cappedFiles.length; j++) {
        const a = cappedFiles[i] < cappedFiles[j] ? cappedFiles[i] : cappedFiles[j];
        const b = cappedFiles[i] < cappedFiles[j] ? cappedFiles[j] : cappedFiles[i];
        const key = `${a}|${b}`;
        coChangeCount.set(key, (coChangeCount.get(key) ?? 0) + 1);
      }
    }
  }

  // Find co-change anomalies (cross-module, high confidence)
  const anomalies: CoChangeAnomaly[] = [];
  for (const [key, count] of coChangeCount) {
    const [fileA, fileB] = key.split('|');
    const moduleA = getModule(fileA, moduleDepth);
    const moduleB = getModule(fileB, moduleDepth);

    if (moduleA === moduleB) continue; // skip same-module pairs

    const commitsA = fileCommitCount.get(fileA) ?? 0;
    const commitsB = fileCommitCount.get(fileB) ?? 0;
    const denominator = commitsA + commitsB - count;
    if (denominator <= 0) continue;
    const jaccard = count / denominator;

    if (jaccard < minConfidence) continue;

    anomalies.push({
      file_a: fileA,
      file_b: fileB,
      co_change_count: count,
      confidence: round(jaccard),
      module_a: moduleA,
      module_b: moduleB,
    });
  }
  anomalies.sort((a, b) => b.confidence - a.confidence);

  // Shotgun surgery hotspots
  const shotgunEntries: ShotgunEntry[] = [];
  for (const [file, shotgunCommits] of fileShotgunCount) {
    const total = fileTotalCount.get(file) ?? 1;
    const ratio = shotgunCommits / total;
    if (ratio > 0.3) {
      shotgunEntries.push({
        file,
        shotgun_commits: shotgunCommits,
        total_commits: total,
        ratio: round(ratio),
      });
    }
  }
  shotgunEntries.sort((a, b) => b.ratio - a.ratio);

  return ok({
    co_change_anomalies: anomalies.slice(0, 50),
    shotgun_surgery: shotgunEntries.slice(0, 30),
    summary: {
      total_anomalies: anomalies.length,
      shotgun_hotspots: shotgunEntries.length,
    },
  });
}

// ════════════════════════════════════════════════════════════════════════
// 3. TECH DEBT SCORING
// ════════════════════════════════════════════════════════════════════════

export function getTechDebt(
  store: Store,
  cwd: string,
  options: {
    module?: string;
    moduleDepth?: number;
    sinceDays?: number;
    weights?: Partial<typeof DEFAULT_DEBT_WEIGHTS>;
    refresh?: boolean;
  } = {},
): TraceMcpResult<TechDebtResult> {
  const { moduleDepth = 2, sinceDays = 180 } = options;
  const w = { ...DEFAULT_DEBT_WEIGHTS, ...options.weights };

  const gitStats = isGitRepo(cwd)
    ? getGitFileStatsWithFixes(cwd, sinceDays)
    : new Map<string, GitFileInfo>();
  const fileGraph = buildFileGraph(store);
  const couplingResults = getCouplingMetrics(store, fileGraph);
  const couplingMap = new Map<string, CouplingResult>();
  for (const c of couplingResults) couplingMap.set(c.file, c);

  // Get complexity per file
  const complexityRows = store.db
    .prepare(`
    SELECT f.path, MAX(s.cyclomatic) as max_cyclomatic
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE s.cyclomatic IS NOT NULL
    GROUP BY f.path
  `)
    .all() as Array<{ path: string; max_cyclomatic: number }>;
  const complexityMap = new Map<string, number>();
  for (const row of complexityRows) complexityMap.set(row.path, row.max_cyclomatic);

  // Get test coverage per file — single JOIN query instead of N+1
  const testedFiles = new Set<string>();
  const testedRows = store.db
    .prepare(`
    SELECT DISTINCT COALESCE(f1.path, f2.path) as tested_path
    FROM edges e
    JOIN edge_types et ON e.edge_type_id = et.id
    JOIN nodes n ON e.target_node_id = n.id
    LEFT JOIN files f1 ON n.node_type = 'file' AND n.ref_id = f1.id
    LEFT JOIN symbols s ON n.node_type = 'symbol' AND n.ref_id = s.id
    LEFT JOIN files f2 ON s.file_id = f2.id
    WHERE et.name = 'test_covers'
  `)
    .all() as Array<{ tested_path: string | null }>;
  for (const row of testedRows) {
    if (row.tested_path) testedFiles.add(row.tested_path);
  }

  // Group files by module
  const allFiles = store.getAllFiles();
  const moduleFiles = new Map<string, string[]>();
  for (const f of allFiles) {
    const mod = getModule(f.path, moduleDepth);
    if (!moduleFiles.has(mod)) moduleFiles.set(mod, []);
    moduleFiles.get(mod)!.push(f.path);
  }

  // Build churn rank percentile across all files
  const churnRaw = new Map<string, number>();
  for (const f of allFiles) {
    churnRaw.set(f.path, gitStats.get(f.path)?.churnPerWeek ?? 0);
  }
  const churnRanks = rankPercentile(churnRaw);

  // Score each module
  const modules: TechDebtModule[] = [];
  for (const [mod, files] of moduleFiles) {
    if (options.module && mod !== options.module) continue;
    if (files.length === 0) continue;

    // Complexity: mean of max_cyclomatic, normalized
    const complexities = files.map((f) => complexityMap.get(f) ?? 0).filter((c) => c > 0);
    const avgComplexity =
      complexities.length > 0 ? complexities.reduce((a, b) => a + b, 0) / complexities.length : 0;
    const sComplexity = clampNormalize(avgComplexity, 15);

    // Coupling: mean instability
    const instabilities = files.map((f) => couplingMap.get(f)?.instability ?? 0);
    const sCoupling = instabilities.reduce((a, b) => a + b, 0) / instabilities.length;

    // Test gap: 1 - (tested files / total files)
    const testedCount = files.filter((f) => testedFiles.has(f)).length;
    const sTestGap = 1 - (files.length > 0 ? testedCount / files.length : 0);

    // Churn: mean churn rank
    const churnVals = files.map((f) => churnRanks.get(f) ?? 0);
    const sChurn = churnVals.reduce((a, b) => a + b, 0) / churnVals.length;

    const score =
      w.complexity * sComplexity +
      w.coupling * sCoupling +
      w.test_gap * sTestGap +
      w.churn * sChurn;

    // Generate recommendations
    const recommendations: TechDebtModule['recommendations'] = [];
    if (sComplexity > 0.7) {
      const complexFiles = files.filter((f) => (complexityMap.get(f) ?? 0) > 15);
      if (complexFiles.length > 0) {
        recommendations.push({
          action: `Reduce complexity in ${complexFiles.length} file(s) with cyclomatic > 15`,
          target: complexFiles[0],
          priority: 'high',
        });
      }
    }
    if (sCoupling > 0.7) {
      recommendations.push({
        action: `Reduce coupling: module has high average instability (${round(sCoupling)})`,
        target: mod,
        priority: 'medium',
      });
    }
    if (sTestGap > 0.5) {
      const untestedImportant = files.filter(
        (f) => !testedFiles.has(f) && (complexityMap.get(f) ?? 0) > 5,
      );
      if (untestedImportant.length > 0) {
        recommendations.push({
          action: `Add tests for ${untestedImportant.length} complex untested file(s)`,
          target: untestedImportant[0],
          priority: 'high',
        });
      }
    }
    if (sChurn > 0.7 && sComplexity > 0.5) {
      recommendations.push({
        action: 'Stabilize: high churn + complexity = maintenance risk',
        target: mod,
        priority: 'medium',
      });
    }

    modules.push({
      module: mod,
      score: round(score),
      grade: debtGrade(score),
      breakdown: {
        complexity: round(sComplexity),
        coupling: round(sCoupling),
        test_gap: round(sTestGap),
        churn: round(sChurn),
      },
      file_count: files.length,
      recommendations,
    });
  }

  modules.sort((a, b) => b.score - a.score);

  const totalScore =
    modules.length > 0 ? modules.reduce((s, m) => s + m.score, 0) / modules.length : 0;

  return ok({
    modules: modules.slice(0, 50),
    project_score: round(totalScore),
    project_grade: debtGrade(totalScore),
  });
}

// ════════════════════════════════════════════════════════════════════════
// 4. CHANGE RISK ASSESSMENT
// ════════════════════════════════════════════════════════════════════════

export function assessChangeRisk(
  store: Store,
  cwd: string,
  opts: {
    filePath?: string;
    symbolId?: string;
    sinceDays?: number;
    weights?: Partial<typeof DEFAULT_RISK_WEIGHTS>;
  },
): TraceMcpResult<ChangeRiskResult> {
  if (!opts.filePath && !opts.symbolId) {
    return err(validationError('Provide either file_path or symbol_id'));
  }

  const w = { ...DEFAULT_RISK_WEIGHTS, ...opts.weights };
  const sinceDays = opts.sinceDays ?? 180;
  let targetFile: string;
  let targetSymbolId: string | undefined;

  if (opts.symbolId) {
    const sym = store.getSymbolBySymbolId(opts.symbolId);
    if (!sym) return err(validationError(`Symbol not found: ${opts.symbolId}`));
    const file = store.getFileById(sym.file_id);
    targetFile = file?.path ?? 'unknown';
    targetSymbolId = opts.symbolId;
  } else {
    targetFile = opts.filePath!;
  }

  // Signal 1: Blast radius
  let blastFiles = 0;
  let blastSymbols = 0;
  const file = store.getFile(targetFile);
  if (file) {
    const symbols = store.getSymbolsByFile(file.id);
    const primarySym = symbols.find((s) => s.kind === 'class') ?? symbols[0];
    if (primarySym) {
      const nodeId = store.getNodeId('symbol', primarySym.id);
      if (nodeId) {
        const visited = new Set<number>();
        visited.add(nodeId);
        const edges = store.traverseEdges(nodeId, 'incoming', 3);
        const affectedFiles = new Set<number>();
        for (const edge of edges) {
          const ref = store.getNodeRef(edge.source_node_id);
          if (!ref) continue;
          if (ref.nodeType === 'symbol') {
            blastSymbols++;
            const s = store.getSymbolById(ref.refId);
            if (s) affectedFiles.add(s.file_id);
          } else if (ref.nodeType === 'file') {
            affectedFiles.add(ref.refId);
          }
        }
        blastFiles = affectedFiles.size;
      }
    }
  }
  const sBlast = clampNormalize(blastFiles, 50);

  // Signal 2: Complexity
  const complexityRow = store.db
    .prepare(`
    SELECT MAX(s.cyclomatic) as max_cyc
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE f.path = ?
  `)
    .get(targetFile) as { max_cyc: number | null } | undefined;
  const sComplexity = clampNormalize(complexityRow?.max_cyc ?? 0, 20);

  // Signal 3: Churn
  let sChurn = 0;
  let gitAvailable = false;
  if (isGitRepo(cwd)) {
    gitAvailable = true;
    const gitStats = getGitFileStatsWithFixes(cwd, sinceDays);
    // Rank against all indexed files
    const allFiles = store.getAllFiles();
    const churnRaw = new Map<string, number>();
    for (const f of allFiles) {
      churnRaw.set(f.path, gitStats.get(f.path)?.churnPerWeek ?? 0);
    }
    const ranks = rankPercentile(churnRaw);
    sChurn = ranks.get(targetFile) ?? 0;
  }

  // Signal 4: Test gap — single query instead of per-symbol N+1
  let hasTestCoverage = false;
  if (file) {
    const testRow = store.db
      .prepare(`
      SELECT 1 FROM edges e
      JOIN edge_types et ON e.edge_type_id = et.id
      JOIN nodes n ON e.target_node_id = n.id
      WHERE et.name = 'test_covers' AND (
        (n.node_type = 'file' AND n.ref_id = ?)
        OR (n.node_type = 'symbol' AND n.ref_id IN (SELECT id FROM symbols WHERE file_id = ?))
      )
      LIMIT 1
    `)
      .get(file.id, file.id);
    hasTestCoverage = !!testRow;
  }
  const sTestGap = hasTestCoverage ? 0 : 1;

  // Signal 5: Coupling
  const couplingResults = getCouplingMetrics(store);
  const coupling = couplingResults.find((c) => c.file === targetFile);
  const sCoupling = coupling?.instability ?? 0;

  // Composite score
  const signalsAvailable = 3 + (gitAvailable ? 1 : 0) + 1; // blast, complexity, test, coupling always; churn if git
  const confidence = signalsAvailable / 5;

  const riskScore =
    w.blast_radius * sBlast +
    w.complexity * sComplexity +
    w.churn * sChurn +
    w.test_gap * sTestGap +
    w.coupling * sCoupling;

  // Mitigations
  const mitigations: string[] = [];
  if (sTestGap > 0.5) mitigations.push('Add test coverage before modifying this code');
  if (sBlast > 0.5)
    mitigations.push(
      `High blast radius (${blastFiles} files affected) — consider incremental rollout`,
    );
  if (sComplexity > 0.7)
    mitigations.push('High complexity — consider refactoring before modifying');
  if (sChurn > 0.7)
    mitigations.push('Frequently changed file — review recent change history for context');

  return ok({
    target: { file: targetFile, symbol_id: targetSymbolId },
    risk_score: round(riskScore),
    risk_level: riskLevel(riskScore),
    confidence: round(confidence),
    factors: [
      {
        signal: 'blast_radius',
        value: round(sBlast),
        weight: w.blast_radius,
        contribution: round(w.blast_radius * sBlast),
        detail: `${blastFiles} files, ${blastSymbols} symbols in blast radius`,
      },
      {
        signal: 'complexity',
        value: round(sComplexity),
        weight: w.complexity,
        contribution: round(w.complexity * sComplexity),
        detail: `Max cyclomatic: ${complexityRow?.max_cyc ?? 0}`,
      },
      {
        signal: 'churn',
        value: round(sChurn),
        weight: w.churn,
        contribution: round(w.churn * sChurn),
        detail: gitAvailable ? `Churn percentile: ${round(sChurn * 100)}%` : 'Git unavailable',
      },
      {
        signal: 'test_gap',
        value: sTestGap,
        weight: w.test_gap,
        contribution: round(w.test_gap * sTestGap),
        detail: hasTestCoverage ? 'Has test coverage' : 'No test coverage',
      },
      {
        signal: 'coupling',
        value: round(sCoupling),
        weight: w.coupling,
        contribution: round(w.coupling * sCoupling),
        detail: `Instability: ${round(sCoupling)}`,
      },
    ],
    mitigations,
    blast_radius: { files: blastFiles, symbols: blastSymbols },
  });
}

// ════════════════════════════════════════════════════════════════════════
// 5. HEALTH TRENDS
// ════════════════════════════════════════════════════════════════════════

export function getHealthTrends(
  store: Store,
  opts: { filePath?: string; module?: string; limit?: number },
): TraceMcpResult<HealthTrendResult> {
  if (!opts.filePath && !opts.module) {
    return err(validationError('Provide either file_path or module'));
  }

  const limit = opts.limit ?? 50;
  const target = opts.filePath ?? opts.module!;

  const rows = opts.filePath
    ? (store.db
        .prepare(`
        SELECT * FROM pi_health_history
        WHERE file_path = ?
        ORDER BY recorded_at DESC
        LIMIT ?
      `)
        .all(target, limit) as PIHealthRow[])
    : (store.db
        .prepare(`
        SELECT file_path, recorded_at,
               AVG(bug_score) as bug_score,
               AVG(complexity_avg) as complexity_avg,
               AVG(coupling_ce) as coupling_ce,
               AVG(churn_per_week) as churn_per_week,
               AVG(test_coverage) as test_coverage
        FROM pi_health_history
        WHERE file_path LIKE ? || '%'
        GROUP BY recorded_at
        ORDER BY recorded_at DESC
        LIMIT ?
      `)
        .all(target, limit) as PIHealthRow[]);

  const dataPoints: HealthTrendPoint[] = rows.reverse().map((r) => ({
    date: r.recorded_at,
    bug_score: r.bug_score,
    complexity_avg: r.complexity_avg,
    coupling: r.coupling_ce,
    churn: r.churn_per_week,
    test_coverage: r.test_coverage,
  }));

  // Determine trend from bug_score movement
  let trend: HealthTrendResult['trend'] = 'stable';
  if (dataPoints.length >= 2) {
    const recent = dataPoints.slice(-3).filter((d) => d.bug_score != null);
    const older = dataPoints.slice(0, 3).filter((d) => d.bug_score != null);
    if (recent.length > 0 && older.length > 0) {
      const recentAvg = recent.reduce((s, d) => s + d.bug_score!, 0) / recent.length;
      const olderAvg = older.reduce((s, d) => s + d.bug_score!, 0) / older.length;
      const delta = recentAvg - olderAvg;
      if (delta < -0.05) trend = 'improving';
      else if (delta > 0.05) trend = 'degrading';
    }
  }

  return ok({ target, data_points: dataPoints, trend });
}

// ════════════════════════════════════════════════════════════════════════
// CACHING HELPERS
// ════════════════════════════════════════════════════════════════════════

interface PIHealthRow {
  file_path: string;
  recorded_at: string;
  bug_score: number | null;
  complexity_avg: number | null;
  coupling_ce: number | null;
  churn_per_week: number | null;
  test_coverage: number | null;
}

function getCachedBugPredictions(
  store: Store,
  limit: number,
  minScore: number,
  filePattern?: string,
  ttlMs = 60 * 60 * 1000,
): BugPredictionResult | null {
  try {
    const snapshot = store.db
      .prepare(`
      SELECT id, created_at FROM pi_snapshots
      WHERE snapshot_type = 'bug_prediction'
      ORDER BY created_at DESC LIMIT 1
    `)
      .get() as { id: number; created_at: string } | undefined;

    if (!snapshot) return null;
    const snapshotFull = store.db
      .prepare('SELECT file_count FROM pi_snapshots WHERE id = ?')
      .get(snapshot.id) as { file_count: number | null } | undefined;

    // Check if fresh
    const age = Date.now() - new Date(snapshot.created_at).getTime();
    if (age > ttlMs) return null;

    let query = `
      SELECT bs.*, f.path as file_path
      FROM pi_bug_scores bs
      JOIN files f ON bs.file_id = f.id
      WHERE bs.snapshot_id = ? AND bs.score >= ?
    `;
    const params: unknown[] = [snapshot.id, minScore];

    if (filePattern) {
      query += ' AND f.path LIKE ?';
      params.push(`%${filePattern}%`);
    }
    query += ' ORDER BY bs.score DESC LIMIT ?';
    params.push(limit);

    const rows = store.db.prepare(query).all(...params) as Array<{
      file_path: string;
      score: number;
      factors: string;
    }>;

    return {
      predictions: rows.map((r) => {
        const factors = JSON.parse(r.factors || '[]') as BugPrediction['factors'];
        const signalsFired = factors.filter((f) => f.normalized > BUG_SIGNAL_FIRE_THRESHOLD).length;
        return {
          file: r.file_path,
          score: r.score,
          risk: riskLevel(r.score),
          confidence_level: classifyConfidence(signalsFired, 6),
          signals_fired: signalsFired,
          factors,
        };
      }),
      total_files_analyzed: snapshotFull?.file_count ?? rows.length,
      snapshot_id: snapshot.id,
      cached: true,
      _methodology: BUG_PREDICTION_METHODOLOGY,
    };
  } catch {
    return null;
  }
}

function saveBugPredictionCache(
  store: Store,
  predictions: BugPrediction[],
  cwd: string,
): number | null {
  try {
    let gitHead: string | null = null;
    try {
      gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, stdio: 'pipe', timeout: 5000 })
        .toString('utf-8')
        .trim();
    } catch {
      /* git unavailable */
    }

    return store.db.transaction(() => {
      const snapshotId = store.db
        .prepare(`
        INSERT INTO pi_snapshots (snapshot_type, git_head, config_hash, file_count, duration_ms)
        VALUES ('bug_prediction', ?, 'default', ?, 0)
      `)
        .run(gitHead, predictions.length).lastInsertRowid as number;

      const insertScore = store.db.prepare(`
        INSERT OR REPLACE INTO pi_bug_scores (snapshot_id, file_id, score, churn_signal, fix_ratio_signal, complexity_signal, coupling_signal, pagerank_signal, author_signal, factors)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      // Pre-fetch all file records to avoid N+1 getFile() calls
      const allFiles = store.getAllFiles();
      const fileByPath = new Map<string, { id: number }>();
      for (const f of allFiles) fileByPath.set(f.path, f);

      for (const pred of predictions) {
        const file = fileByPath.get(pred.file);
        if (!file) continue;

        const f = pred.factors;
        insertScore.run(
          snapshotId,
          file.id,
          pred.score,
          f.find((x) => x.signal === 'churn')?.normalized ?? 0,
          f.find((x) => x.signal === 'fix_ratio')?.normalized ?? 0,
          f.find((x) => x.signal === 'complexity')?.normalized ?? 0,
          f.find((x) => x.signal === 'coupling')?.normalized ?? 0,
          f.find((x) => x.signal === 'pagerank')?.normalized ?? 0,
          f.find((x) => x.signal === 'authors')?.normalized ?? 0,
          JSON.stringify(f),
        );
      }

      // Append to health history
      const insertHealth = store.db.prepare(`
        INSERT INTO pi_health_history (file_path, bug_score, complexity_avg, coupling_ce, churn_per_week, test_coverage)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const pred of predictions) {
        const f = pred.factors;
        insertHealth.run(
          pred.file,
          pred.score,
          f.find((x) => x.signal === 'complexity')?.raw_value ?? null,
          f.find((x) => x.signal === 'coupling')?.raw_value ?? null,
          f.find((x) => x.signal === 'churn')?.raw_value ?? null,
          null, // test_coverage computed separately
        );
      }

      return snapshotId;
    })();
  } catch (e) {
    logger.warn({ error: e }, 'Failed to save bug prediction cache');
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
// UTILS
// ════════════════════════════════════════════════════════════════════════

function round(v: number, decimals = 3): number {
  const m = 10 ** decimals;
  return Math.round(v * m) / m;
}
