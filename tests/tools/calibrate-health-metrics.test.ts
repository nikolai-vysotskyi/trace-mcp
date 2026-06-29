import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs harness has no type declarations; we test its pure math.
import { precisionAtK, spearman } from '../../scripts/calibrate-health-metrics.mjs';

describe('calibrate-health-metrics pure helpers', () => {
  describe('spearman', () => {
    it('returns +1 for a perfectly monotonically increasing pair', () => {
      const xs = [1, 2, 3, 4, 5];
      const ys = [10, 20, 30, 40, 50];
      expect(spearman(xs, ys)).toBeCloseTo(1, 5);
    });

    it('returns -1 for a perfectly inverse relationship', () => {
      const xs = [1, 2, 3, 4, 5];
      const ys = [50, 40, 30, 20, 10];
      expect(spearman(xs, ys)).toBeCloseTo(-1, 5);
    });

    it('returns ~0 for no rank relationship', () => {
      const xs = [1, 2, 3, 4];
      const ys = [1, 1, 1, 1];
      expect(spearman(xs, ys)).toBe(0);
    });

    it('handles ties via average ranks', () => {
      const xs = [1, 1, 2, 3];
      const ys = [5, 5, 6, 7];
      // Monotonic with matching ties → strong positive correlation
      expect(spearman(xs, ys)).toBeGreaterThan(0.9);
    });

    it('returns 0 for fewer than 3 points', () => {
      expect(spearman([1, 2], [2, 4])).toBe(0);
    });
  });

  describe('precisionAtK', () => {
    it('scores 1 when top-K by signal exactly matches top-K by label', () => {
      const files = ['a', 'b', 'c', 'd'];
      const signal = new Map([
        ['a', 9],
        ['b', 8],
        ['c', 1],
        ['d', 0],
      ]);
      const label = new Map([
        ['a', 3],
        ['b', 2],
        ['c', 0],
        ['d', 0],
      ]);
      expect(precisionAtK(files, signal, label, 2)).toBe(1);
    });

    it('scores 0 when the signal anti-correlates with the label', () => {
      const files = ['a', 'b', 'c', 'd'];
      const signal = new Map([
        ['a', 0],
        ['b', 1],
        ['c', 8],
        ['d', 9],
      ]);
      const label = new Map([
        ['a', 3],
        ['b', 2],
        ['c', 0],
        ['d', 0],
      ]);
      expect(precisionAtK(files, signal, label, 2)).toBe(0);
    });

    it('returns 0 when there are no labeled files', () => {
      const files = ['a', 'b'];
      const signal = new Map([
        ['a', 5],
        ['b', 1],
      ]);
      const label = new Map<string, number>();
      expect(precisionAtK(files, signal, label, 2)).toBe(0);
    });
  });
});
