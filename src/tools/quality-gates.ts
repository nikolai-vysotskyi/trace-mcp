/**
 * Quality Gates — configurable pass/fail predicates for CI integration.
 *
 * Evaluates a set of quality rules against existing metrics:
 * - Max cyclomatic complexity
 * - Max coupling instability
 * - Max circular import chains
 * - Max dead exports percent
 * - Max tech debt grade
 * - Max security critical findings
 * - Max antipattern count
 * - Max code smell count
 *
 * Returns structured gate results with exit code semantics (0 = pass, 1 = fail).
 */

import type { Store } from '../db/store.js';
import { getCouplingMetrics, getDependencyCycles } from './graph-analysis.js';
import { getDeadCodeV2 } from './dead-code.js';
import { scanSecurity, type SecurityScanResult } from './security-scan.js';
import { scanCodeSmells, type CodeSmellResult } from './code-smells.js';
import { getTechDebt, type TechDebtResult } from './predictive-intelligence.js';
import { detectAntipatterns } from './antipatterns.js';
import { logger } from '../logger.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

const GateSeverity = z.enum(['error', 'warning']);
type GateSeverity = z.infer<typeof GateSeverity>;

const GateScope = z.enum(['all', 'new_symbols', 'changed_symbols']);

const QualityGateRuleSchema = z.object({
  threshold: z.union([z.number(), z.string()]),
  severity: GateSeverity.default('error'),
  scope: GateScope.optional(),
  message: z.string().optional(),
});

export const QualityGatesConfigSchema = z.object({
  enabled: z.boolean().default(true),
  fail_on: z.enum(['error', 'warning', 'none']).default('error'),
  rules: z.object({
    max_cyclomatic_complexity: QualityGateRuleSchema.optional(),
    max_coupling_instability: QualityGateRuleSchema.optional(),
    max_circular_import_chains: QualityGateRuleSchema.optional(),
    max_dead_exports_percent: QualityGateRuleSchema.optional(),
    max_tech_debt_grade: QualityGateRuleSchema.optional(),
    max_security_critical_findings: QualityGateRuleSchema.optional(),
    max_antipattern_count: QualityGateRuleSchema.optional(),
    max_code_smell_count: QualityGateRuleSchema.optional(),
  }).default({}),
});

export type QualityGatesConfig = z.infer<typeof QualityGatesConfigSchema>;
type QualityGateRuleName = keyof QualityGatesConfig['rules'];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface GateCheckResult {
  rule: string;
  status: 'pass' | 'warning' | 'error';
  actual: number | string;
  threshold: number | string;
  message?: string;
  details?: string;
}

interface QualityGateReport {
  gates: GateCheckResult[];
  summary: {
    total: number;
    passed: number;
    warnings: number;
    errors: number;
    result: 'PASS' | 'FAIL';
  };
}

// ---------------------------------------------------------------------------
// Grade comparison
// ---------------------------------------------------------------------------

const GRADE_ORDER: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, F: 5 };

function gradeExceeds(actual: string, threshold: string): boolean {
  return (GRADE_ORDER[actual] ?? 5) > (GRADE_ORDER[threshold] ?? 5);
}

// ---------------------------------------------------------------------------
// Main evaluation
// ---------------------------------------------------------------------------

export function evaluateQualityGates(
  store: Store,
  projectRoot: string,
  gatesConfig: QualityGatesConfig,
  options: {
    sinceDays?: number;
    moduleDepth?: number;
  } = {},
): QualityGateReport {
  const { rules, fail_on } = gatesConfig;
  const gates: GateCheckResult[] = [];

  // 1. Max cyclomatic complexity
  if (rules.max_cyclomatic_complexity) {
    const rule = rules.max_cyclomatic_complexity;
    const threshold = Number(rule.threshold);
    const rows = store.db.prepare(`
      SELECT MAX(s.cyclomatic) as max_cc
      FROM symbols s
      WHERE s.cyclomatic IS NOT NULL
    `).get() as { max_cc: number | null } | undefined;
    const actual = rows?.max_cc ?? 0;
    gates.push({
      rule: 'max_cyclomatic_complexity',
      status: actual > threshold ? rule.severity : 'pass',
      actual,
      threshold,
      message: rule.message,
      details: actual > threshold ? `Highest cyclomatic: ${actual}` : undefined,
    });
  }

  // 2. Max coupling instability
  if (rules.max_coupling_instability) {
    const rule = rules.max_coupling_instability;
    const threshold = Number(rule.threshold);
    const couplingMetrics = getCouplingMetrics(store);
    const maxInstability = couplingMetrics.reduce((max, c) => Math.max(max, c.instability), 0);
    gates.push({
      rule: 'max_coupling_instability',
      status: maxInstability > threshold ? rule.severity : 'pass',
      actual: Math.round(maxInstability * 1000) / 1000,
      threshold,
      message: rule.message,
      details: maxInstability > threshold
        ? `Most unstable: ${couplingMetrics.sort((a, b) => b.instability - a.instability)[0]?.file} (${Math.round(maxInstability * 100)}%)`
        : undefined,
    });
  }

  // 3. Max circular import chains
  if (rules.max_circular_import_chains) {
    const rule = rules.max_circular_import_chains;
    const threshold = Number(rule.threshold);
    const cycles = getDependencyCycles(store);
    const actual = cycles.length;
    gates.push({
      rule: 'max_circular_import_chains',
      status: actual > threshold ? rule.severity : 'pass',
      actual,
      threshold,
      message: rule.message,
      details: actual > threshold
        ? `Cycles: ${cycles.slice(0, 3).map(c => c.files.join(' → ')).join('; ')}`
        : undefined,
    });
  }

  // 4. Max dead exports percent
  if (rules.max_dead_exports_percent) {
    const rule = rules.max_dead_exports_percent;
    const threshold = Number(rule.threshold);
    const deadResult = getDeadCodeV2(store, { threshold: 0.5 });
    const totalExported = store.db.prepare(`
      SELECT COUNT(*) as cnt FROM symbols WHERE is_exported = 1 AND kind != 'method'
    `).get() as { cnt: number };
    const deadPercent = totalExported.cnt > 0
      ? Math.round((deadResult.dead_symbols.length / totalExported.cnt) * 1000) / 10
      : 0;
    gates.push({
      rule: 'max_dead_exports_percent',
      status: deadPercent > threshold ? rule.severity : 'pass',
      actual: deadPercent,
      threshold,
      message: rule.message,
      details: deadPercent > threshold
        ? `${deadResult.dead_symbols.length} dead of ${totalExported.cnt} exports (${deadPercent}%)`
        : undefined,
    });
  }

  // 5. Max tech debt grade
  if (rules.max_tech_debt_grade) {
    const rule = rules.max_tech_debt_grade;
    const thresholdGrade = String(rule.threshold).toUpperCase();
    const debtResult = getTechDebt(store, projectRoot, {
      moduleDepth: options.moduleDepth,
      sinceDays: options.sinceDays,
    });
    if (debtResult.isOk()) {
      const debt = debtResult.value as TechDebtResult;
      const worstModule = debt.modules.reduce<{ module: string; grade: string } | null>(
        (worst, m) => {
          if (!worst || gradeExceeds(m.grade, worst.grade)) return m;
          return worst;
        },
        null,
      );
      const worstGrade = worstModule?.grade ?? 'A';
      gates.push({
        rule: 'max_tech_debt_grade',
        status: gradeExceeds(worstGrade, thresholdGrade) ? rule.severity : 'pass',
        actual: worstGrade,
        threshold: thresholdGrade,
        message: rule.message,
        details: gradeExceeds(worstGrade, thresholdGrade)
          ? `Module "${worstModule?.module}" graded ${worstGrade}`
          : undefined,
      });
    } else {
      logger.warn('Tech debt evaluation failed, skipping gate');
    }
  }

  // 6. Max security critical findings
  if (rules.max_security_critical_findings) {
    const rule = rules.max_security_critical_findings;
    const threshold = Number(rule.threshold);
    const secResult = scanSecurity(store, projectRoot, {
      rules: ['all'],
      severityThreshold: 'critical',
    });
    let actual = 0;
    if (secResult.isOk()) {
      actual = (secResult.value as SecurityScanResult).findings.length;
    }
    gates.push({
      rule: 'max_security_critical_findings',
      status: actual > threshold ? rule.severity : 'pass',
      actual,
      threshold,
      message: rule.message,
    });
  }

  // 7. Max antipattern count
  if (rules.max_antipattern_count) {
    const rule = rules.max_antipattern_count;
    const threshold = Number(rule.threshold);
    const apResult = detectAntipatterns(store, projectRoot, {});
    let actual = 0;
    if (apResult.isOk()) {
      actual = apResult.value.findings.length;
    }
    gates.push({
      rule: 'max_antipattern_count',
      status: actual > threshold ? rule.severity : 'pass',
      actual,
      threshold,
      message: rule.message,
    });
  }

  // 8. Max code smell count
  if (rules.max_code_smell_count) {
    const rule = rules.max_code_smell_count;
    const threshold = Number(rule.threshold);
    const smellResult = scanCodeSmells(store, projectRoot, {});
    let actual = 0;
    if (smellResult.isOk()) {
      actual = (smellResult.value as CodeSmellResult).total;
    }
    gates.push({
      rule: 'max_code_smell_count',
      status: actual > threshold ? rule.severity : 'pass',
      actual,
      threshold,
      message: rule.message,
    });
  }

  // Compute summary
  const errors = gates.filter(g => g.status === 'error').length;
  const warnings = gates.filter(g => g.status === 'warning').length;
  const passed = gates.filter(g => g.status === 'pass').length;

  let result: 'PASS' | 'FAIL' = 'PASS';
  if (fail_on === 'error' && errors > 0) result = 'FAIL';
  if (fail_on === 'warning' && (errors > 0 || warnings > 0)) result = 'FAIL';

  return {
    gates,
    summary: {
      total: gates.length,
      passed,
      warnings,
      errors,
      result,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI formatter
// ---------------------------------------------------------------------------

export function formatGateReport(report: QualityGateReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('  trace-mcp quality gate check');
  lines.push('');

  for (const gate of report.gates) {
    const icon = gate.status === 'pass' ? '✓' : gate.status === 'warning' ? '⚠' : '✗';
    const label = gate.rule.replace(/_/g, ' ');
    const suffix = gate.status === 'pass' ? '' : ` — ${gate.status.toUpperCase()}`;
    const detail = gate.details ?? `actual: ${gate.actual}, threshold: ${gate.threshold}`;
    lines.push(`  ${icon} ${label}: ${detail}${suffix}`);
    if (gate.message && gate.status !== 'pass') {
      lines.push(`    ${gate.message}`);
    }
  }

  lines.push('');
  const { passed, warnings, errors, result } = report.summary;
  lines.push(`  Result: ${result} (${passed} passed, ${errors} error(s), ${warnings} warning(s))`);
  lines.push('');

  return lines.join('\n');
}
