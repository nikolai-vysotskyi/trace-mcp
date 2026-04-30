/**
 * Calibrated retrieval confidence (0–1) for ranked-list responses.
 *
 * Signals fused (in order of weight):
 *   - top1_strength    (40%)  How high the top result's score is, normalized to [0,1].
 *   - top_gap          (25%)  Gap between top1 and top2 — large gap = unambiguous match.
 *   - identity_match   (20%)  Top result name/fqn exactly equals the query (case-insensitive).
 *   - freshness        (15%)  Share of results in 'fresh' state.
 *
 * The output is intentionally a single number so an agent can gate follow-up reads
 * on `_meta.confidence > 0.6` without parsing structure.
 *
 * Calibration is heuristic for v1 — Phase 4 will tune per-repo from a ranking ledger.
 */

import type { FreshnessLevel, FreshnessSummary } from './freshness.js';

export interface ConfidenceWeights {
  top1_strength: number;
  top_gap: number;
  identity_match: number;
  freshness: number;
}

const DEFAULT_WEIGHTS: ConfidenceWeights = {
  top1_strength: 0.4,
  top_gap: 0.25,
  identity_match: 0.2,
  freshness: 0.15,
};

export interface ConfidenceInput {
  /** Result scores in descending order. Empty / single-element arrays are handled. */
  scores: number[];
  /** Optional name/fqn of the top result — checked against `query` for identity match. */
  topName?: string | null;
  topFqn?: string | null;
  /** Optional original query — only used for identity match. */
  query?: string;
  /** Per-result freshness levels in the same order as `scores`. */
  freshness?: FreshnessLevel[];
  /** Pre-aggregated freshness summary (alternative to passing per-entry levels). */
  freshnessSummary?: FreshnessSummary;
  weights?: Partial<ConfidenceWeights>;
}

export interface ConfidenceBreakdown {
  /** Calibrated confidence in [0, 1]. */
  confidence: number;
  /** Categorical bucket — handy for hint messages and logs. */
  level: 'low' | 'medium' | 'high';
  /** Per-channel contributions in [0, 1] for transparency. */
  signals: {
    top1_strength: number;
    top_gap: number;
    identity_match: number;
    freshness: number;
  };
}

/**
 * Compute a calibrated confidence breakdown for a ranked retrieval response.
 * Returns `null` when the input has no scores — callers should attach `_meta.confidence`
 * only when this returns a value.
 */
export function computeRetrievalConfidence(input: ConfidenceInput): ConfidenceBreakdown | null {
  if (!input.scores || input.scores.length === 0) return null;

  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const sum = weights.top1_strength + weights.top_gap + weights.identity_match + weights.freshness;
  // Normalize so partial weight overrides still produce [0,1].
  const norm = sum > 0 ? sum : 1;
  const w = {
    top1_strength: weights.top1_strength / norm,
    top_gap: weights.top_gap / norm,
    identity_match: weights.identity_match / norm,
    freshness: weights.freshness / norm,
  };

  const top1 = input.scores[0] ?? 0;
  const top2 = input.scores[1] ?? 0;
  const maxScore = Math.max(...input.scores);

  const top1Strength = clamp01(maxScore > 0 ? top1 / maxScore : 0);
  const topGap = clamp01(maxScore > 0 ? Math.max(0, top1 - top2) / maxScore : 0);

  const identityMatch = input.query
    ? identityScore(input.query, input.topName ?? null, input.topFqn ?? null)
    : 0;

  const freshnessScore = freshnessSignal(
    input.freshness,
    input.freshnessSummary,
    input.scores.length,
  );

  const confidence = clamp01(
    w.top1_strength * top1Strength +
      w.top_gap * topGap +
      w.identity_match * identityMatch +
      w.freshness * freshnessScore,
  );

  return {
    confidence: round3(confidence),
    level: confidence >= 0.7 ? 'high' : confidence >= 0.4 ? 'medium' : 'low',
    signals: {
      top1_strength: round3(top1Strength),
      top_gap: round3(topGap),
      identity_match: round3(identityMatch),
      freshness: round3(freshnessScore),
    },
  };
}

function identityScore(query: string, name: string | null, fqn: string | null): number {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const n = (name ?? '').trim().toLowerCase();
  const f = (fqn ?? '').trim().toLowerCase();
  if (n === q || f === q) return 1;
  // Partial credit when the query exactly matches the trailing FQN segment (e.g. "Foo" vs "pkg.Foo").
  if (f.endsWith(`.${q}`) || f.endsWith(`/${q}`) || f.endsWith(`::${q}`)) return 0.7;
  return 0;
}

function freshnessSignal(
  levels: FreshnessLevel[] | undefined,
  summary: FreshnessSummary | undefined,
  totalResults: number,
): number {
  if (summary) {
    const total = summary.fresh + summary.edited_uncommitted + summary.stale_index;
    return total > 0 ? summary.fresh / total : 1;
  }
  if (levels && levels.length > 0) {
    let fresh = 0;
    for (const l of levels) {
      if (l === 'fresh') fresh += 1;
    }
    return fresh / levels.length;
  }
  // No freshness signal available → treat as fully fresh; the freshness channel
  // shouldn't penalize tools that don't yet emit per-entry freshness.
  return totalResults > 0 ? 1 : 0;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
