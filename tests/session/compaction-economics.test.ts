/**
 * Compaction economics tests (TRA-1703).
 *
 * MIT attribution: ported 1:1 from NVlabs/SoL-Pi
 * (https://github.com/NVlabs/SoL-Pi —
 * `tests/online-context-compact-economics.test.ts`). Same cases, same
 * expectations; only the import path changed.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPACTION_ECONOMICS,
  decideCompaction,
  estimateRemainingRequests,
} from '../../src/session/compaction-economics.js';

function decision(overrides: Partial<Parameters<typeof decideCompaction>[0]> = {}) {
  return decideCompaction({
    writeTokens: 80_000,
    archiveTokens: 60_000,
    memoTokens: 1_000,
    contextTokens: 80_000,
    completedBoundaryRequestCounts: [4, 6, 5],
    remainingBoundaries: 4,
    averageContextTokenIncrement: 2_000,
    contextWindowTokens: 200_000,
    priorCompactionCount: 0,
    carriedDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
    cacheWriteReadRatio: 1,
    economics: DEFAULT_COMPACTION_ECONOMICS,
    ...overrides,
  });
}

describe('Session compaction economics (SoL-Pi online-context-compact 1:1 port)', () => {
  it('estimates the remaining request horizon from completed boundaries', () => {
    expect(
      estimateRemainingRequests({
        completedBoundaryRequestCounts: [4, 6, 5],
        remainingBoundaries: 3,
        scale: 1,
        standardDeviationK: 0,
        contextTokens: 100_000,
        contextWindowTokens: 200_000,
        averageContextTokenIncrement: 5_000,
      }),
    ).toMatchObject({
      requestsPerBoundaryMean: 5,
      expectedRemainingRequests: 16,
      windowRequestUpperBound: 20,
    });
  });

  it('rejects a compaction that cannot remove more than its summary', () => {
    expect(decision({ archiveTokens: 500, memoTokens: 1_000 })).toMatchObject({
      compact: false,
      reason: 'non_positive_saving',
    });
  });

  it('compacts when the economic breakeven fits the remaining horizon', () => {
    expect(decision()).toMatchObject({ compact: true, reason: 'economic' });
  });

  it('uses window protection even when the ordinary economic gate defers', () => {
    expect(
      decision({
        contextTokens: 195_000,
        cacheWriteReadRatio: 100,
        economics: { ...DEFAULT_COMPACTION_ECONOMICS, windowReserveTokens: 10_000 },
      }),
    ).toMatchObject({ compact: true, reason: 'window_protection' });
  });

  it('defers economic compaction when no cache ratio is available', () => {
    expect(decision({ cacheWriteReadRatio: null })).toMatchObject({
      compact: false,
      reason: 'cache_ratio_unavailable',
    });
  });

  it('charges carried debt only after the first compaction', () => {
    const result = decision({
      priorCompactionCount: 1,
      cacheWriteReadRatio: 2,
      carriedDebtTokens: 2_000_000,
    });
    expect(result.compact).toBe(false);
    expect(result.reason).toBe('deferred_carried_debt');
    expect(result.combinedBreakevenRequests).toBeGreaterThan(result.breakevenRequests ?? 0);
  });

  // Branch coverage beyond the 1:1 upstream port (TRA-1700 follow-up): gates
  // the ported suite never exercises — horizon window cap, variance damping,
  // and the three remaining deferral reasons.
  describe('deferral branches', () => {
    it('caps the horizon at the window upper bound', () => {
      const h = estimateRemainingRequests({
        completedBoundaryRequestCounts: [5, 7, 6],
        remainingBoundaries: 5,
        scale: 1,
        standardDeviationK: 0,
        contextTokens: 90_000,
        contextWindowTokens: 100_000,
        averageContextTokenIncrement: 5_000,
      });
      expect(h.windowRequestUpperBound).toBe(2);
      expect(h.expectedRemainingRequests).toBe(2);
    });

    it('damps small samples and applies sample variance on larger ones', () => {
      const small = estimateRemainingRequests({
        completedBoundaryRequestCounts: [10],
        remainingBoundaries: 2,
        scale: 1,
        standardDeviationK: 2,
        contextTokens: 0,
        contextWindowTokens: null,
        averageContextTokenIncrement: null,
      });
      expect(small.requestsPerBoundaryLowerBound).toBe(5);

      const varied = estimateRemainingRequests({
        completedBoundaryRequestCounts: [4, 6, 8, 6],
        remainingBoundaries: 1,
        scale: 1,
        standardDeviationK: 1,
        contextTokens: 0,
        contextWindowTokens: null,
        averageContextTokenIncrement: null,
      });
      expect(varied.requestsPerBoundaryLowerBound).toBeCloseTo(4.367, 2);
    });

    it('reports horizon_unavailable without boundary history or window pressure', () => {
      expect(decision({ completedBoundaryRequestCounts: null })).toMatchObject({
        compact: false,
        reason: 'horizon_unavailable',
      });
    });

    it('defers when breakeven exceeds the horizon', () => {
      const d = decision({
        cacheWriteReadRatio: 12.5,
        writeTokens: 100_000,
        completedBoundaryRequestCounts: [2],
        remainingBoundaries: 1,
      });
      expect(d.breakevenRequests).toBeGreaterThan(d.effectiveHorizonRequests ?? 0);
      expect(d).toMatchObject({ compact: false, reason: 'deferred_economic' });
    });

    it('holds subsequent compactions to the margin gate', () => {
      const d = decision({
        cacheWriteReadRatio: 12.5,
        writeTokens: 51_304, // breakeven ~= 10
        completedBoundaryRequestCounts: [11],
        remainingBoundaries: 1,
        priorCompactionCount: 1,
      });
      expect(d.breakevenRequests).toBeCloseTo(10, 0);
      expect(d.expectedRemainingRequests).toBe(12);
      expect(d).toMatchObject({ compact: false, reason: 'deferred_subsequent_margin' });
    });

    it('compacts again once margin and debt gates open', () => {
      expect(
        decision({
          cacheWriteReadRatio: 12.5,
          writeTokens: 51_304,
          completedBoundaryRequestCounts: [20],
          remainingBoundaries: 2,
          priorCompactionCount: 1,
        }),
      ).toMatchObject({ compact: true, reason: 'economic' });
    });
  });
});
