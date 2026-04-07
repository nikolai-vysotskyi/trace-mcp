/**
 * CI Quality Baseline — capture and compare quality scores across CI runs.
 *
 * Uses the existing graph_snapshots table (via Store.insertGraphSnapshot / getGraphSnapshots)
 * to persist per-commit quality metrics and compute deltas.
 */
import type { Store } from '../db/store.js';
import type { CIReport } from './report-generator.js';

export interface BaselineComparison {
  riskDelta: number;
  untestedDelta: number;
  violationsDelta: number;
  deadExportsDelta: number;
  regressionDetected: boolean;
  baselineCommit: string | null;
  baselineDate: string;
}

const SNAPSHOT_TYPE = 'ci_quality_baseline';
const REGRESSION_THRESHOLD = 0.15; // 15% risk score increase = regression

/**
 * Save current report metrics as the baseline for future comparisons.
 */
export function captureBaseline(store: Store, report: CIReport, commitHash: string): void {
  store.insertGraphSnapshot(SNAPSHOT_TYPE, {
    riskScore: report.riskAnalysis.overallScore,
    riskLevel: report.riskAnalysis.overallLevel,
    untestedGaps: report.testCoverage.totalUntested,
    violations: report.architectureViolations.totalViolations,
    deadExports: report.deadCode.totalDead,
    changedFiles: report.summary.changedFileCount,
    affectedFiles: report.summary.affectedFileCount,
  }, commitHash);
}

/**
 * Compare current report against the most recent baseline.
 * Returns null if no baseline exists.
 */
export function compareWithBaseline(store: Store, current: CIReport): BaselineComparison | null {
  const snapshots = store.getGraphSnapshots(SNAPSHOT_TYPE, { limit: 1 });
  if (snapshots.length === 0) return null;

  const snapshot = snapshots[0];
  const baseline = JSON.parse(snapshot.data) as {
    riskScore: number;
    untestedGaps: number;
    violations: number;
    deadExports: number;
  };

  const riskDelta = current.riskAnalysis.overallScore - baseline.riskScore;

  return {
    riskDelta: Math.round(riskDelta * 100) / 100,
    untestedDelta: current.testCoverage.totalUntested - baseline.untestedGaps,
    violationsDelta: current.architectureViolations.totalViolations - baseline.violations,
    deadExportsDelta: current.deadCode.totalDead - baseline.deadExports,
    regressionDetected: riskDelta > REGRESSION_THRESHOLD,
    baselineCommit: snapshot.commit_hash,
    baselineDate: snapshot.created_at,
  };
}
