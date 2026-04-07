/**
 * GitHub annotation generator for CI reports.
 *
 * Produces annotations in two formats:
 * - GitHub Actions workflow commands (::warning file=...::message)
 * - JSON array for GitHub Checks API
 */
import type { CIReport } from './report-generator.js';

export interface GitHubAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title: string;
}

/**
 * Generate annotations from a CI report.
 */
export function generateAnnotations(report: CIReport): GitHubAnnotation[] {
  const annotations: GitHubAnnotation[] = [];

  // Architecture violations → failure
  for (const v of report.architectureViolations.violations) {
    annotations.push({
      path: v.source_file,
      start_line: 1,
      end_line: 1,
      annotation_level: 'failure',
      title: 'Architecture violation',
      message: `${v.source_layer} \u2192 ${v.target_layer}: ${v.rule}`,
    });
  }

  // High-risk files → warning
  for (const f of report.riskAnalysis.files.filter((f) => f.score >= 0.5)) {
    annotations.push({
      path: f.file,
      start_line: 1,
      end_line: 1,
      annotation_level: 'warning',
      title: 'High risk file',
      message: `Risk score ${f.score} (complexity=${f.complexity}, churn=${f.churn}, coupling=${f.coupling})`,
    });
  }

  // Untested affected symbols → notice (limit to 10)
  for (const gap of report.testCoverage.gaps.slice(0, 10)) {
    annotations.push({
      path: gap.file,
      start_line: 1,
      end_line: 1,
      annotation_level: 'notice',
      title: 'Untested export',
      message: `${gap.kind} "${gap.name}" has no test coverage`,
    });
  }

  // Cross-domain changes → notice
  if (report.domainAnalysis) {
    for (const cd of report.domainAnalysis.crossDomainChanges.slice(0, 5)) {
      annotations.push({
        path: '',
        start_line: 0,
        end_line: 0,
        annotation_level: 'notice',
        title: 'Cross-domain dependency',
        message: `${cd.from} \u2192 ${cd.to} (${cd.edgeCount} edges)`,
      });
    }
  }

  // Baseline regression → warning
  if (report.baseline?.regressionDetected) {
    annotations.push({
      path: '',
      start_line: 0,
      end_line: 0,
      annotation_level: 'warning',
      title: 'Quality regression',
      message: `Risk score increased by ${report.baseline.riskDelta} vs baseline (commit ${report.baseline.baselineCommit ?? 'unknown'})`,
    });
  }

  return annotations;
}

/**
 * Format annotations as GitHub Actions workflow commands.
 */
export function formatGitHubActions(annotations: GitHubAnnotation[]): string {
  return annotations
    .map((a) => {
      const file = a.path ? `file=${a.path},` : '';
      const line = a.start_line > 0 ? `line=${a.start_line},` : '';
      return `::${a.annotation_level} ${file}${line}title=${a.title}::${a.message}`;
    })
    .join('\n');
}

/**
 * Format annotations as JSON for GitHub Checks API.
 */
export function formatAnnotationsJson(annotations: GitHubAnnotation[]): string {
  return JSON.stringify(annotations, null, 2);
}
