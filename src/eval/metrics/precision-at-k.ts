/**
 * precision@k = |{retrieved files in top-K} ∩ {expected files}| / K.
 *
 * In the slice we only score by file path (not symbol_id) — the dataset
 * lists expected files. A result counts as a hit if its `file` matches any
 * expected file. Duplicate hits on the same expected file are de-duplicated
 * so the metric stays in [0, 1] even if a target file shows up twice in
 * top-K.
 */

import type { CaseResultItem, MetricResult } from '../types.js';

export interface PrecisionAtKInput {
  results: readonly CaseResultItem[];
  expected_files: readonly string[];
  k: number;
}

export function precisionAtK(input: PrecisionAtKInput): MetricResult {
  const { results, expected_files, k } = input;
  if (k <= 0) {
    return { name: `precision@${k}`, value: 0, details: { reason: 'k must be > 0' } };
  }

  const expectedSet = new Set(expected_files);
  const topK = results.slice(0, k);
  const matchedExpected = new Set<string>();

  for (const item of topK) {
    if (expectedSet.has(item.file)) {
      matchedExpected.add(item.file);
    }
  }

  // Numerator = # of expected files covered (each at most once); denominator = k.
  // This penalises both irrelevant hits and missing hits, keeping the metric
  // bounded in [0, 1].
  const value = matchedExpected.size / k;
  return {
    name: `precision@${k}`,
    value,
    details: { matched: matchedExpected.size, k },
  };
}
