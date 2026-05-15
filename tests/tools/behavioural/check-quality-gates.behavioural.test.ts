/**
 * Behavioural coverage for the `check_quality_gates` MCP tool.
 *
 * Asserts:
 *  - Default (no rules) returns the documented `{ gates, summary }` shape
 *    with `summary.result === 'PASS'`.
 *  - A satisfied rule yields a `pass` gate carrying name/status/value/
 *    threshold.
 *  - A violated rule with severity=error yields an `error` gate and flips
 *    summary.result to FAIL.
 *  - `fail_on: 'none'` keeps summary.result=PASS even when rules trip.
 *  - Each gate object carries the documented shape.
 */

import { describe, expect, it } from 'vitest';
import {
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
  it('default config (no rules) returns documented shape and result=PASS', () => {
    const store = createTestStore();
    const report = evaluateQualityGates(store, projectRoot, configWith({}));
    expect(Array.isArray(report.gates)).toBe(true);
    expect(report.gates.length).toBe(0);
    expect(report.summary).toBeDefined();
    expect(report.summary.total).toBe(0);
    expect(report.summary.result).toBe('PASS');
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
});
