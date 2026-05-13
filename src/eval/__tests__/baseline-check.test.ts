import { describe, expect, it } from 'vitest';
import { type BaselineFile, compareToBaseline, formatBaselineCheckMarkdown } from '../runner.js';
import type { BenchmarkReport } from '../types.js';

/**
 * Tests for the --check-baseline pipeline.
 *
 * The CLI does the file I/O + process.exit; the runner's `compareToBaseline`
 * is the pure comparator. These tests pin the comparator's pass/fail
 * semantics for the three baseline metrics:
 *
 *   - precision@5 mean (higher_is_better)
 *   - mrr           (higher_is_better)
 *   - first_hit_rank mean (lower_is_better)
 *
 * Anything that flips a "pass" to a "fail" here will flip the CI job too.
 */

function makeReport(precisionAt5: number, mrr: number, rankMean: number): BenchmarkReport {
  return {
    dataset_id: 'default',
    dataset_description: 'fixture',
    ran_at: '2026-05-13T00:00:00.000Z',
    duration_ms: 1,
    k: 5,
    total_cases: 1,
    cases: [],
    rollup: [
      { metric: 'first_hit_rank', mean: rankMean, min: rankMean, max: rankMean, n: 1 },
      { metric: 'mrr', mean: mrr, min: mrr, max: mrr, n: 1 },
      { metric: 'precision@5', mean: precisionAt5, min: precisionAt5, max: precisionAt5, n: 1 },
    ],
  };
}

const baseline: BaselineFile = {
  dataset: 'default',
  metrics: {
    precision_at_5_mean: 0.1833,
    mrr: 0.9167,
    first_hit_rank_mean: 1.0,
  },
  tolerance: {
    precision_at_5_mean: 0.02,
    mrr: 0.05,
    first_hit_rank_mean: 0.2,
  },
};

describe('compareToBaseline', () => {
  it('passes when current metrics match the baseline exactly', () => {
    const report = makeReport(0.1833, 0.9167, 1.0);
    const check = compareToBaseline(report, baseline);
    expect(check.passed).toBe(true);
    expect(check.lines).toHaveLength(3);
    expect(check.lines.every((l) => l.passed)).toBe(true);
  });

  it('fails when precision regresses below tolerance', () => {
    // baseline precision 0.1833 minus tolerance 0.02 = 0.1633 floor.
    // 0.10 is clearly below the floor — must fail.
    const report = makeReport(0.1, 0.9167, 1.0);
    const check = compareToBaseline(report, baseline);
    expect(check.passed).toBe(false);
    const precisionLine = check.lines.find((l) => l.metric === 'precision_at_5_mean');
    expect(precisionLine?.passed).toBe(false);
    expect(precisionLine?.reason).toMatch(/current 0\.1 < baseline/);

    // Other metrics still pass — confirms the failure is isolated.
    expect(check.lines.find((l) => l.metric === 'mrr')?.passed).toBe(true);
    expect(check.lines.find((l) => l.metric === 'first_hit_rank_mean')?.passed).toBe(true);

    // Markdown formatter renders the FAIL row.
    const md = formatBaselineCheckMarkdown(check);
    expect(md).toContain('Status: FAIL');
    expect(md).toContain('precision_at_5_mean');
    expect(md).toContain('| FAIL |');
  });

  it('passes when first_hit_rank improves (lower is better)', () => {
    // Current rank mean 0.8 is lower (better) than baseline 1.0 — must pass
    // even though it's outside the tolerance window in the "good" direction.
    const report = makeReport(0.1833, 0.9167, 0.8);
    const check = compareToBaseline(report, baseline);
    expect(check.passed).toBe(true);
    const rankLine = check.lines.find((l) => l.metric === 'first_hit_rank_mean');
    expect(rankLine?.passed).toBe(true);
    expect(rankLine?.direction).toBe('lower_is_better');
    // Delta is current - baseline = -0.2 (improvement)
    expect(rankLine?.delta).toBeCloseTo(-0.2, 6);
  });

  it('fails when first_hit_rank regresses above tolerance', () => {
    // baseline 1.0 + tolerance 0.2 = 1.2 ceiling. 1.5 must fail.
    const report = makeReport(0.1833, 0.9167, 1.5);
    const check = compareToBaseline(report, baseline);
    expect(check.passed).toBe(false);
    const rankLine = check.lines.find((l) => l.metric === 'first_hit_rank_mean');
    expect(rankLine?.passed).toBe(false);
    expect(rankLine?.reason).toMatch(/current 1\.5 > baseline/);
  });

  it('skips metrics absent from the baseline (partial baselines are valid)', () => {
    const partial: BaselineFile = {
      dataset: 'default',
      metrics: { mrr: 0.9 },
      tolerance: { mrr: 0.05 },
    };
    const report = makeReport(0.0, 0.9, 5.0);
    const check = compareToBaseline(report, partial);
    expect(check.lines).toHaveLength(1);
    expect(check.lines[0].metric).toBe('mrr');
    expect(check.passed).toBe(true);
  });
});
