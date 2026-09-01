import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs helper shared by the perf scripts, no types.
import { fitGrowth, median, p95, round, thin } from '../../../scripts/perf-lib.mjs';

/**
 * The perf harness runs for 45 minutes on a developer machine, so nothing checks
 * it in CI. These four are the arithmetic that turns those 45 minutes into the
 * numbers in docs/perf/baseline.json — a silent break here would publish a wrong
 * baseline that nothing else would catch.
 */
describe('perf-lib', () => {
  it('takes the nearest-rank p95, i.e. the max for small samples', () => {
    expect(p95([5, 1, 3])).toBe(5);
    expect(p95([10])).toBe(10);
    // 20 samples is the first size where p95 is not simply the max.
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
  });

  it('medians both odd and even sample counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('fits heap growth as MB per hour, not per sample', () => {
    // 10 MB over 30 minutes is 20 MB/h — the metric's units are the whole point.
    expect(
      fitGrowth([
        { t_min: 0, heap_mb: 10 },
        { t_min: 15, heap_mb: 15 },
        { t_min: 30, heap_mb: 20 },
      ]),
    ).toBe(20);
    expect(
      fitGrowth([
        { t_min: 0, heap_mb: 12 },
        { t_min: 15, heap_mb: 12 },
        { t_min: 30, heap_mb: 12 },
      ]),
    ).toBe(0);
  });

  it('reports null rather than a number it cannot support', () => {
    expect(fitGrowth([{ t_min: 0, heap_mb: 10 }])).toBeNull();
    // Every sample at the same instant: no slope exists, and 0 would be a lie.
    expect(
      fitGrowth([
        { t_min: 1, heap_mb: 10 },
        { t_min: 1, heap_mb: 20 },
        { t_min: 1, heap_mb: 30 },
      ]),
    ).toBeNull();
    expect(round(Number.NaN)).toBeNull();
  });

  it('thins a series without losing either end', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i);
    const out = thin(xs, 10);
    expect(out.length).toBeLessThanOrEqual(11);
    expect(out[0]).toBe(0);
    // The last sample is the one a reader checks first — it must survive.
    expect(out[out.length - 1]).toBe(99);
    expect(thin([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });
});
