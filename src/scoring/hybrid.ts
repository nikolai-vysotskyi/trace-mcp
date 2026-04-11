// Re-export computeIdentityScore from signal-fusion (canonical location)
export { computeIdentityScore } from './signal-fusion.js';

interface HybridScoreParams {
  /** FTS5 BM25 rank, normalized 0-1 */
  relevance: number;
  /** PageRank score (already normalized 0-1) */
  pagerank: number;
  /** Recency factor 0-1 based on indexed_at */
  recency: number;
  /** Bonus based on symbol kind 0-1 */
  typeBonus: number;
  /** Identity match bonus 0-1 (exact/prefix/segment) */
  identity?: number;
}

/**
 * Weighted hybrid score combining multiple signals.
 *
 * When identity bonus is present (exact/prefix/segment name match),
 * it dominates: identity 40%, relevance 30%, pagerank 15%, recency 10%, typeBonus 5%.
 * Otherwise: relevance 50%, pagerank 25%, recency 15%, typeBonus 10%.
 */
export function hybridScore(params: HybridScoreParams): number {
  const id = params.identity ?? 0;
  if (id > 0) {
    return (
      0.40 * id +
      0.30 * params.relevance +
      0.15 * params.pagerank +
      0.10 * params.recency +
      0.05 * params.typeBonus
    );
  }
  return (
    0.50 * params.relevance +
    0.25 * params.pagerank +
    0.15 * params.recency +
    0.10 * params.typeBonus
  );
}

const KIND_BONUS: Record<string, number> = {
  class: 1.0,
  interface: 0.9,
  trait: 0.9,
  enum: 0.8,
  function: 0.7,
  method: 0.6,
  type: 0.5,
  constant: 0.4,
  property: 0.3,
  variable: 0.2,
  enum_case: 0.3,
  namespace: 0.1,
};

/** Get type bonus for a symbol kind. */
export function getTypeBonus(kind: string): number {
  return KIND_BONUS[kind] ?? 0.1;
}

/**
 * Convert an indexed_at timestamp to a 0-1 recency score.
 * Score decays over `maxAgeDays` (default 30).
 */
export function computeRecency(
  indexedAt: string,
  now?: Date,
  maxAgeDays = 30,
): number {
  const d = new Date(indexedAt);
  const ref = now ?? new Date();
  const ageMs = ref.getTime() - d.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0, 1 - ageDays / maxAgeDays);
}
