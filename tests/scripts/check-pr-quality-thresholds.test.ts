/**
 * TRA-1100: the pass bar behind scripts/check-pr-quality-thresholds.mjs, which
 * is the release-time gate on the full PR-review quality harness (TRA-568).
 * Thresholds are the ones preregistered in docs/perf/prereg-pr-quality.md —
 * kept in sync here, not re-derived. Also covers the code-review finding that
 * an incomplete or wrong-corpus run must not report MET just because its
 * metrics look fine (verified by reproducing the reviewer's repro first).
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations
import { evaluatePrQualityThresholds } from '../../scripts/check-pr-quality-thresholds.mjs';

const FULL_RUN = {
  pr_count: 60,
  failed: [],
  model: 'claude-sonnet-4-5',
  judge_model: 'claude-sonnet-4-5',
};

describe('evaluatePrQualityThresholds()', () => {
  it('passes the actual re-run recorded in benchmarks/pr-context/quality.json', () => {
    const r = evaluatePrQualityThresholds({
      ...FULL_RUN,
      aggregates: {
        baseline: { understood_rate: 0.65, false_positives_per_pr: 0.5833333333333334 },
        trace: { understood_rate: 0.6666666666666666, false_positives_per_pr: 0.8 },
      },
    });
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('fails on the struck 2026-09-06 run TRA-1090 diagnosed', () => {
    const r = evaluatePrQualityThresholds({
      ...FULL_RUN,
      aggregates: {
        baseline: { understood_rate: 0.65, false_positives_per_pr: 0.65 },
        trace: { understood_rate: 0.5, false_positives_per_pr: 1.2 },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBe(2);
    expect(r.reasons.join(' ')).toContain('comprehension dropped 15.0pp');
    expect(r.reasons.join(' ')).toContain('false positives per PR rose by 0.55');
  });

  it('passes exactly at the bar (10pp drop, +0.5 FP)', () => {
    const r = evaluatePrQualityThresholds({
      ...FULL_RUN,
      aggregates: {
        baseline: { understood_rate: 0.65, false_positives_per_pr: 0.5 },
        trace: { understood_rate: 0.55, false_positives_per_pr: 1.0 },
      },
    });
    expect(r.ok).toBe(true);
  });

  it('fails one point past the comprehension bar alone', () => {
    const r = evaluatePrQualityThresholds({
      ...FULL_RUN,
      aggregates: {
        baseline: { understood_rate: 0.65, false_positives_per_pr: 0.5 },
        trace: { understood_rate: 0.549, false_positives_per_pr: 0.5 },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBe(1);
    expect(r.reasons[0]).toContain('comprehension');
  });

  it('a trace arm that understands more and finds fewer false positives always passes', () => {
    const r = evaluatePrQualityThresholds({
      ...FULL_RUN,
      aggregates: {
        baseline: { understood_rate: 0.65, false_positives_per_pr: 0.8 },
        trace: { understood_rate: 0.8, false_positives_per_pr: 0.1 },
      },
    });
    expect(r.ok).toBe(true);
  });

  // Code review (2026-09-07): the checker only read four display strings and
  // ignored corpus size, failure count, and model identity — a 1-row smoke
  // run or a mostly-failed attempt reported MET.
  it('fails a 1-row smoke run with perfect metrics rather than reporting MET', () => {
    const r = evaluatePrQualityThresholds({
      pr_count: 1,
      failed: [],
      model: 'claude-sonnet-4-5',
      judge_model: 'claude-sonnet-4-5',
      aggregates: {
        baseline: { understood_rate: 1, false_positives_per_pr: 0 },
        trace: { understood_rate: 1, false_positives_per_pr: 0 },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('registered corpus is 60');
  });

  it('fails a 60-row run where 59 of 60 model calls failed, even with perfect metrics on the rest', () => {
    const r = evaluatePrQualityThresholds({
      pr_count: 1,
      failed: new Array(59).fill({ dir: 'x', error: 'timeout' }),
      model: 'claude-sonnet-4-5',
      judge_model: 'claude-sonnet-4-5',
      aggregates: {
        baseline: { understood_rate: 1, false_positives_per_pr: 0 },
        trace: { understood_rate: 1, false_positives_per_pr: 0 },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('failed a model call');
  });

  it('fails a full run made with the wrong reviewer or judge model', () => {
    const r = evaluatePrQualityThresholds({
      pr_count: 60,
      failed: [],
      model: 'wrong-model',
      judge_model: 'also-wrong',
      aggregates: {
        baseline: { understood_rate: 0.65, false_positives_per_pr: 0.5 },
        trace: { understood_rate: 0.65, false_positives_per_pr: 0.5 },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('reviewer model was "wrong-model"');
    expect(r.reasons.join(' ')).toContain('judge model was "also-wrong"');
  });
});
