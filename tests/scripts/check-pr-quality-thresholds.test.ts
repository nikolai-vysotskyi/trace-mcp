/**
 * TRA-1100: the pass bar behind scripts/check-pr-quality-thresholds.mjs, which
 * is the release-time gate on the full PR-review quality harness (TRA-568).
 * Thresholds are the ones preregistered in docs/perf/prereg-pr-quality.md —
 * kept in sync here, not re-derived.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import { evaluatePrQualityThresholds } from '../../scripts/check-pr-quality-thresholds.mjs';

describe('evaluatePrQualityThresholds()', () => {
  it('passes the actual re-run recorded in docs/_data/pr_context_quality.json', () => {
    const r = evaluatePrQualityThresholds({
      baseline_understood: '65%',
      trace_understood: '67%',
      baseline_false_positives: '0.58',
      trace_false_positives: '0.80',
    });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('fails on the struck 2026-09-06 run TRA-1090 diagnosed', () => {
    const r = evaluatePrQualityThresholds({
      baseline_understood: '65%',
      trace_understood: '50%',
      baseline_false_positives: '0.65',
      trace_false_positives: '1.20',
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBe(2);
    expect(r.reasons.join(' ')).toContain('comprehension dropped 15.0pp');
    expect(r.reasons.join(' ')).toContain('false positives per PR rose by 0.55');
  });

  it('passes exactly at the bar (10pp drop, +0.5 FP)', () => {
    const r = evaluatePrQualityThresholds({
      baseline_understood: '65%',
      trace_understood: '55%',
      baseline_false_positives: '0.50',
      trace_false_positives: '1.00',
    });
    expect(r.ok).toBe(true);
  });

  it('fails one point past the comprehension bar alone', () => {
    const r = evaluatePrQualityThresholds({
      baseline_understood: '65%',
      trace_understood: '54.9%',
      baseline_false_positives: '0.50',
      trace_false_positives: '0.50',
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toContain('comprehension');
  });

  it('a trace arm that understands more and finds fewer false positives always passes', () => {
    const r = evaluatePrQualityThresholds({
      baseline_understood: '65%',
      trace_understood: '80%',
      baseline_false_positives: '0.80',
      trace_false_positives: '0.10',
    });
    expect(r.ok).toBe(true);
  });
});
