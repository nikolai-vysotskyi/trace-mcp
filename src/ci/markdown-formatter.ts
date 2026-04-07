/**
 * Markdown formatter for CI reports.
 * Produces GitHub-flavored markdown with collapsible sections.
 */
import type { CIReport } from './report-generator.js';

export function formatMarkdown(report: CIReport): string {
  const lines: string[] = [];

  // Header
  lines.push('## trace-mcp Change Impact Report');
  lines.push('');

  // Summary table
  lines.push('### Summary');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Changed files | ${report.summary.changedFileCount} |`);
  lines.push(`| Affected files (blast radius) | ${report.summary.affectedFileCount} |`);
  lines.push(`| Risk level | **${report.summary.riskLevel}** |`);
  lines.push(`| Untested affected paths | ${report.summary.untestedGaps} |`);
  lines.push(`| Architecture violations | ${report.summary.violations} |`);
  lines.push(`| Dead exports introduced | ${report.summary.deadExports} |`);
  if (report.summary.domainsCrossed != null) {
    lines.push(`| Domains crossed | ${report.summary.domainsCrossed} |`);
  }
  if (report.summary.servicesAffected != null) {
    lines.push(`| Services affected | ${report.summary.servicesAffected} |`);
  }
  lines.push('');

  // Changed files — split into code (has symbols) and non-code
  if (report.changedFiles.length > 0) {
    const codeFiles = report.changedFiles.filter((f) => f.symbolCount > 0);
    const nonCodeFiles = report.changedFiles.filter((f) => f.symbolCount === 0);

    if (codeFiles.length > 0) {
      lines.push(`<details><summary>Changed Code Files (${codeFiles.length})</summary>`);
      lines.push('');
      lines.push('| File | Symbols | Avg Complexity |');
      lines.push('|------|---------|----------------|');
      for (const f of codeFiles) {
        lines.push(`| \`${f.path}\` | ${f.symbolCount} | ${f.avgCyclomatic} |`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }

    if (nonCodeFiles.length > 0) {
      lines.push(`<details><summary>Changed Non-Code Files (${nonCodeFiles.length})</summary>`);
      lines.push('');
      for (const f of nonCodeFiles) {
        lines.push(`- \`${f.path}\``);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  // Blast radius
  if (report.blastRadius.totalAffected > 0) {
    const truncNote = report.blastRadius.truncated ? ' (truncated)' : '';
    lines.push(`<details><summary>Blast Radius (${report.blastRadius.totalAffected} files affected${truncNote})</summary>`);
    lines.push('');
    lines.push('| File | Edge Type | Depth |');
    lines.push('|------|-----------|-------|');
    for (const entry of report.blastRadius.entries.slice(0, 50)) {
      lines.push(`| \`${entry.path}\` | ${entry.edgeType} | ${entry.depth} |`);
    }
    if (report.blastRadius.entries.length > 50) {
      lines.push(`| ... | _${report.blastRadius.entries.length - 50} more_ | |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Test coverage gaps
  if (report.testCoverage.gaps.length > 0) {
    lines.push(`<details><summary>Test Coverage Gaps (${report.testCoverage.gaps.length} untested symbols)</summary>`);
    lines.push('');
    lines.push('| Symbol | File | Kind | Signature |');
    lines.push('|--------|------|------|-----------|');
    for (const gap of report.testCoverage.gaps.slice(0, 30)) {
      const sig = gap.signature ? `\`${gap.signature.slice(0, 60)}\`` : '-';
      lines.push(`| ${gap.name} | \`${gap.file}\` | ${gap.kind} | ${sig} |`);
    }
    if (report.testCoverage.gaps.length > 30) {
      lines.push(`| ... | _${report.testCoverage.gaps.length - 30} more_ | | |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Risk analysis
  if (report.riskAnalysis.files.length > 0) {
    lines.push(`<details><summary>Risk Analysis (overall: ${report.riskAnalysis.overallLevel}, score: ${report.riskAnalysis.overallScore})</summary>`);
    lines.push('');
    lines.push('| File | Complexity | Churn | Coupling | Blast | Score |');
    lines.push('|------|-----------|-------|----------|-------|-------|');
    for (const f of report.riskAnalysis.files) {
      lines.push(`| \`${f.file}\` | ${f.complexity} | ${f.churn} | ${f.coupling} | ${f.blastSize} | **${f.score}** |`);
    }
    lines.push('');
    lines.push('_Signals normalized 0-1. Score = 0.30*complexity + 0.25*churn + 0.25*coupling + 0.20*blast_');
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Architecture violations
  if (report.architectureViolations.totalViolations > 0) {
    lines.push(`<details><summary>Architecture Violations (${report.architectureViolations.totalViolations})</summary>`);
    lines.push('');
    lines.push('| Source File | Source Layer | Target File | Target Layer | Rule |');
    lines.push('|------------|-------------|-------------|--------------|------|');
    for (const v of report.architectureViolations.violations) {
      lines.push(`| \`${v.source_file}\` | ${v.source_layer} | \`${v.target_file}\` | ${v.target_layer} | ${v.rule} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Dead code
  if (report.deadCode.totalDead > 0) {
    lines.push(`<details><summary>Dead Exports Introduced (${report.deadCode.totalDead})</summary>`);
    lines.push('');
    lines.push('| Symbol | File | Kind |');
    lines.push('|--------|------|------|');
    for (const d of report.deadCode.symbols) {
      lines.push(`| ${d.name} | \`${d.file}\` | ${d.kind} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Domain analysis
  if (report.domainAnalysis) {
    const da = report.domainAnalysis;
    lines.push(`<details><summary>Domain Boundaries (${da.domainsAffected.length} domains)</summary>`);
    lines.push('');
    if (da.reviewTeams.length > 0) {
      lines.push(`**Review needed from:** ${da.reviewTeams.join(', ')}`);
      lines.push('');
    }
    lines.push('| Domain | Changed Files | Impacted Files |');
    lines.push('|--------|--------------|----------------|');
    for (const d of da.domainsAffected) {
      lines.push(`| ${d.name} | ${d.filesChanged} | ${d.filesImpacted} |`);
    }
    if (da.crossDomainChanges.length > 0) {
      lines.push('');
      lines.push('**Cross-domain dependencies:**');
      lines.push('');
      lines.push('| From | To | Edges |');
      lines.push('|------|----|-------|');
      for (const cd of da.crossDomainChanges) {
        lines.push(`| ${cd.from} | ${cd.to} | ${cd.edgeCount} |`);
      }
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Code ownership
  if (report.ownershipAnalysis) {
    const oa = report.ownershipAnalysis;
    lines.push(`<details><summary>Code Ownership (${oa.teamsCrossed.length} contributors)</summary>`);
    lines.push('');
    lines.push(`**Teams involved:** ${oa.teamsCrossed.join(', ')}`);
    lines.push('');
    lines.push('| File | Primary Owner | Ownership % |');
    lines.push('|------|--------------|-------------|');
    for (const o of oa.owners) {
      lines.push(`| \`${o.file}\` | ${o.primaryOwner} | ${o.percentage}% |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Deployment impact
  if (report.deploymentImpact) {
    const di = report.deploymentImpact;
    lines.push(`<details><summary>Deployment Impact (${di.servicesAffected.length} services)</summary>`);
    lines.push('');
    lines.push('| Service | Type | Changed Files |');
    lines.push('|---------|------|--------------|');
    for (const s of di.servicesAffected) {
      lines.push(`| ${s.name} | ${s.type} | ${s.filesChanged} |`);
    }
    if (di.crossServiceChanges > 0) {
      lines.push('');
      lines.push(`**Cross-service edges affected:** ${di.crossServiceChanges}`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Baseline comparison
  if (report.baseline) {
    const b = report.baseline;
    const commitRef = b.baselineCommit ? ` (vs ${b.baselineCommit})` : '';
    lines.push(`<details open><summary>Trend vs Baseline${commitRef}</summary>`);
    lines.push('');
    lines.push('| Metric | Delta | |');
    lines.push('|--------|-------|-|');
    lines.push(`| Risk score | ${formatDelta(b.riskDelta)} | ${arrow(b.riskDelta, true)} |`);
    lines.push(`| Untested gaps | ${formatDeltaInt(b.untestedDelta)} | ${arrow(b.untestedDelta, true)} |`);
    lines.push(`| Violations | ${formatDeltaInt(b.violationsDelta)} | ${arrow(b.violationsDelta, true)} |`);
    lines.push(`| Dead exports | ${formatDeltaInt(b.deadExportsDelta)} | ${arrow(b.deadExportsDelta, true)} |`);
    if (b.regressionDetected) {
      lines.push('');
      lines.push('**Warning: quality regression detected**');
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('_Generated by [trace-mcp](https://github.com/nikolai-vysotskyi/trace-mcp) CI Report_');

  return lines.join('\n');
}

export function formatJson(report: CIReport): string {
  return JSON.stringify(report, null, 2);
}

// ── Helpers ──

function formatDelta(n: number): string {
  return n >= 0 ? `+${Math.round(n * 100) / 100}` : `${Math.round(n * 100) / 100}`;
}

function formatDeltaInt(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

function arrow(n: number, higherIsWorse: boolean): string {
  if (n === 0) return '-';
  const up = n > 0;
  if (higherIsWorse) return up ? '▲ worse' : '▼ better';
  return up ? '▲ better' : '▼ worse';
}
