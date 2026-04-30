import { describe, expect, it } from 'vitest';
import {
  averageMetrics,
  evaluateRanking,
  meanReciprocalRank,
  ndcgAtK,
  recallAtK,
} from '../../src/scoring/retrieval-metrics.js';

describe('retrieval-metrics', () => {
  describe('ndcgAtK', () => {
    it('returns 1.0 for a perfect ranking (all relevant in top positions)', () => {
      const ranked = ['a', 'b', 'c', 'd'];
      const relevant = new Set(['a', 'b']);
      expect(ndcgAtK(ranked, relevant, 10)).toBeCloseTo(1, 5);
    });

    it('decays with each additional irrelevant position before the relevant one', () => {
      const top1 = ndcgAtK(['hit', 'miss', 'miss'], new Set(['hit']), 10);
      const top2 = ndcgAtK(['miss', 'hit', 'miss'], new Set(['hit']), 10);
      const top3 = ndcgAtK(['miss', 'miss', 'hit'], new Set(['hit']), 10);
      expect(top1).toBeGreaterThan(top2);
      expect(top2).toBeGreaterThan(top3);
    });

    it('returns 0 when no relevant items appear in top-k', () => {
      expect(ndcgAtK(['miss', 'miss'], new Set(['gone']), 10)).toBe(0);
    });

    it('returns 1 when relevant set is empty (nothing to miss)', () => {
      expect(ndcgAtK(['x'], new Set(), 10)).toBe(1);
    });
  });

  describe('meanReciprocalRank', () => {
    it('returns 1/(rank) of the first hit', () => {
      expect(meanReciprocalRank(['hit'], new Set(['hit']))).toBe(1);
      expect(meanReciprocalRank(['miss', 'hit'], new Set(['hit']))).toBeCloseTo(0.5, 5);
      expect(meanReciprocalRank(['m', 'm', 'hit'], new Set(['hit']))).toBeCloseTo(1 / 3, 5);
    });

    it('returns 0 when no hit is found', () => {
      expect(meanReciprocalRank(['a', 'b'], new Set(['z']))).toBe(0);
    });
  });

  describe('recallAtK', () => {
    it('counts hits within top-k divided by total relevant', () => {
      expect(recallAtK(['a', 'b', 'c'], new Set(['a', 'b']), 10)).toBe(1);
      expect(recallAtK(['a', 'x'], new Set(['a', 'b', 'c']), 10)).toBeCloseTo(1 / 3, 5);
    });

    it('truncates at k', () => {
      expect(recallAtK(['x', 'a', 'b'], new Set(['a', 'b']), 1)).toBe(0); // a/b not in top-1
    });
  });

  describe('evaluateRanking + averageMetrics', () => {
    it('averages per-query metrics into a single aggregate', () => {
      const r1 = evaluateRanking(['hit'], new Set(['hit']), 5);
      const r2 = evaluateRanking(['miss', 'hit'], new Set(['hit']), 5);
      const avg = averageMetrics([r1, r2]);
      expect(avg.mrr).toBeCloseTo((1 + 0.5) / 2, 5);
      expect(avg.k).toBe(5);
    });

    it('handles empty input', () => {
      expect(averageMetrics([])).toEqual({ ndcg_at_k: 0, mrr: 0, recall_at_k: 0, k: 0 });
    });
  });
});
