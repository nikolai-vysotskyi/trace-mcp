/**
 * Behavioural coverage for the `check_quality_gates` MCP tool.
 *
 * Asserts:
 *  - Empty rules returns `NO_GATES_CONFIGURED` (not a misleading PASS) with
 *    an actionable `_warnings` entry.
 *  - A satisfied rule yields a `pass` gate carrying name/status/value/
 *    threshold.
 *  - A violated rule with severity=error yields an `error` gate and flips
 *    summary.result to FAIL.
 *  - `fail_on: 'none'` keeps summary.result=PASS even when rules trip.
 *  - Each gate object carries the documented shape.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY_GATES,
  evaluateQualityGates,
  type QualityGatesConfig,
} from '../../../src/tools/quality/quality-gates.js';
import { createTestStore } from '../../test-utils.js';

const projectRoot = process.cwd();

function configWith(
  rules: QualityGatesConfig['rules'],
  failOn: QualityGatesConfig['fail_on'] = 'error',
): QualityGatesConfig {
  return { enabled: true, fail_on: failOn, rules };
}

describe('check_quality_gates — behavioural contract', () => {
  it('empty rules returns NO_GATES_CONFIGURED with actionable warning (not a misleading PASS)', () => {
    const store = createTestStore();
    const report = evaluateQualityGates(store, projectRoot, configWith({}));
    expect(Array.isArray(report.gates)).toBe(true);
    expect(report.gates.length).toBe(0);
    expect(report.summary).toBeDefined();
    expect(report.summary.total).toBe(0);
    expect(report.summary.result).toBe('NO_GATES_CONFIGURED');
    expect(report._warnings).toBeDefined();
    expect(report._warnings?.length).toBeGreaterThan(0);
    expect(report._warnings?.[0]).toMatch(/quality_gates|configured/i);
  });

  it('a satisfied complexity rule yields a pass gate with name/status/value/threshold', () => {
    const store = createTestStore();
    // No symbols inserted → max cyclomatic is 0, threshold 50 → pass.
    const report = evaluateQualityGates(
      store,
      projectRoot,
      configWith({
        max_cyclomatic_complexity: { threshold: 50, severity: 'error' },
      }),
    );
    expect(report.gates.length).toBe(1);
    const gate = report.gates[0];
    expect(gate.rule).toBe('max_cyclomatic_complexity');
    expect(gate.status).toBe('pass');
    expect(typeof gate.actual).toBe('number');
    expect(gate.threshold).toBe(50);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.errors).toBe(0);
    expect(report.summary.result).toBe('PASS');
  });

  it('a violated rule with severity=error flips summary.result to FAIL', () => {
    const store = createTestStore();
    // Insert a single symbol with cyclomatic=42; threshold 10 → violation.
    const fileId = store.insertFile('src/cx.ts', 'typescript', 'h-cx', 100);
    const symId = store.insertSymbol(fileId, {
      symbolId: 'src/cx.ts::hairy#function',
      name: 'hairy',
      kind: 'function',
      fqn: 'hairy',
      byteStart: 0,
      byteEnd: 100,
      lineStart: 1,
      lineEnd: 50,
      signature: 'function hairy()',
    });
    // Bump cyclomatic via raw update.
    store.db.prepare('UPDATE symbols SET cyclomatic = ? WHERE id = ?').run(42, symId);

    const report = evaluateQualityGates(
      store,
      projectRoot,
      configWith({
        max_cyclomatic_complexity: { threshold: 10, severity: 'error' },
      }),
    );
    expect(report.gates.length).toBe(1);
    const gate = report.gates[0];
    expect(gate.status).toBe('error');
    expect(gate.actual).toBe(42);
    expect(gate.threshold).toBe(10);
    expect(report.summary.errors).toBe(1);
    expect(report.summary.result).toBe('FAIL');
  });

  it('fail_on: "none" keeps summary.result=PASS even when rules trip', () => {
    const store = createTestStore();
    const fileId = store.insertFile('src/cx.ts', 'typescript', 'h-cx', 100);
    const symId = store.insertSymbol(fileId, {
      symbolId: 'src/cx.ts::hairy#function',
      name: 'hairy',
      kind: 'function',
      fqn: 'hairy',
      byteStart: 0,
      byteEnd: 100,
      lineStart: 1,
      lineEnd: 50,
      signature: 'function hairy()',
    });
    store.db.prepare('UPDATE symbols SET cyclomatic = ? WHERE id = ?').run(99, symId);

    const report = evaluateQualityGates(
      store,
      projectRoot,
      configWith({ max_cyclomatic_complexity: { threshold: 5, severity: 'error' } }, 'none'),
    );
    expect(report.gates[0].status).toBe('error');
    expect(report.summary.errors).toBe(1);
    // fail_on='none' must keep the overall verdict at PASS.
    expect(report.summary.result).toBe('PASS');
  });

  it('each gate object carries the documented { rule, status, actual, threshold } shape', () => {
    const store = createTestStore();
    const report = evaluateQualityGates(
      store,
      projectRoot,
      configWith({
        max_cyclomatic_complexity: { threshold: 100, severity: 'error' },
        max_circular_import_chains: { threshold: 0, severity: 'warning' },
      }),
    );
    expect(report.gates.length).toBe(2);
    for (const gate of report.gates) {
      expect(typeof gate.rule).toBe('string');
      expect(['pass', 'warning', 'error']).toContain(gate.status);
      expect(['number', 'string']).toContain(typeof gate.actual);
      expect(['number', 'string']).toContain(typeof gate.threshold);
    }
  });

  it('NO_GATES_CONFIGURED short-circuits before any gate evaluation', () => {
    const store = createTestStore();
    const report = evaluateQualityGates(store, projectRoot, configWith({}));
    expect(report.summary.result).toBe('NO_GATES_CONFIGURED');
    // No passed/warning/error counts when nothing ran.
    expect(report.summary.passed).toBe(0);
    expect(report.summary.warnings).toBe(0);
    expect(report.summary.errors).toBe(0);
  });

  it('DEFAULT_QUALITY_GATES, when supplied as rules, evaluates ≥2 gates (opt-in default set)', () => {
    const store = createTestStore();
    const report = evaluateQualityGates(store, projectRoot, configWith(DEFAULT_QUALITY_GATES));
    // The default ruleset must produce at least 2 evaluated gates so callers
    // who opt in actually get a meaningful check, not a single-rule fig-leaf.
    expect(report.gates.length).toBeGreaterThanOrEqual(2);
    expect(report.summary.total).toBe(report.gates.length);
    expect(['PASS', 'FAIL', 'WARNING']).toContain(report.summary.result);
  });

  it('inline-style rules object with explicit gates preserves original PASS/FAIL behavior', () => {
    const store = createTestStore();
    // No symbols => max cyclomatic is 0; threshold 50 => pass; verdict = PASS
    const okReport = evaluateQualityGates(
      store,
      projectRoot,
      configWith({
        max_cyclomatic_complexity: { threshold: 50, severity: 'error' },
      }),
    );
    expect(okReport.summary.result).toBe('PASS');
    expect(okReport._warnings).toBeUndefined();
  });
});
