/**
 * Reciprocal rank for a single query = 1 / rank(first_relevant_result).
 *
 * MRR (Mean Reciprocal Rank) for a dataset is computed at the runner level
 * by averaging this per-case value. A case where no expected file appears
 * in the top-K contributes 0.
 */

import type { CaseResultItem, MetricResult } from '../types.js';

export interface ReciprocalRankInput {
  results: readonly CaseResultItem[];
  expected_files: readonly string[];
}

export interface ReciprocalRankResult extends MetricResult {
  /** 1-indexed rank where the first expected file appeared, or null. */
  first_hit_rank: number | null;
}

export function reciprocalRank(input: ReciprocalRankInput): ReciprocalRankResult {
  const { results, expected_files } = input;
  const expectedSet = new Set(expected_files);

  for (let i = 0; i < results.length; i++) {
    if (expectedSet.has(results[i]!.file)) {
      const rank = i + 1;
      return {
        name: 'reciprocal_rank',
        value: 1 / rank,
        first_hit_rank: rank,
        details: { rank },
      };
    }
  }

  return {
    name: 'reciprocal_rank',
    value: 0,
    first_hit_rank: null,
    details: { reason: 'no expected file found in results' },
  };
}
