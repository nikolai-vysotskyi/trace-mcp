/**
 * Standard retrieval-quality metrics: nDCG@k, MRR, Recall@k.
 *
 * Used by the replay harness (Phase 5) and reusable from any test that wants
 * to verify a ranked list against a ground truth.
 *
 * All metrics expect:
 *   - `ranked`: a list of result identifiers in rank order (best first)
 *   - `relevant`: a set of identifiers known to be correct for the query
 */

export interface MetricsResult {
  ndcg_at_k: number;
  mrr: number;
  recall_at_k: number;
  k: number;
}

export function evaluateRanking(ranked: string[], relevant: Set<string>, k = 10): MetricsResult {
  return {
    ndcg_at_k: ndcgAtK(ranked, relevant, k),
    mrr: meanReciprocalRank(ranked, relevant),
    recall_at_k: recallAtK(ranked, relevant, k),
    k,
  };
}

/** nDCG@k with binary relevance. */
export function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1; // by convention — nothing to find means perfect
  if (ranked.length === 0) return 0;

  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    if (relevant.has(ranked[i] as string)) {
      // gain = 1 (binary), discount = 1 / log2(i + 2)
      dcg += 1 / Math.log2(i + 2);
    }
  }

  // Ideal DCG: assume all relevant items appear in the top-min(k, |relevant|) positions.
  const idealHits = Math.min(k, relevant.size);
  let idcg = 0;
  for (let i = 0; i < idealHits; i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

/** Mean reciprocal rank — 1/rank of the first relevant hit, or 0 if none. */
export function meanReciprocalRank(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i += 1) {
    if (relevant.has(ranked[i] as string)) return 1 / (i + 1);
  }
  return 0;
}

export function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 1;
  let hits = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    if (relevant.has(ranked[i] as string)) hits += 1;
  }
  return hits / relevant.size;
}

/**
 * Average a list of per-query metric results into a single aggregate. Each
 * metric is averaged independently — useful for the harness summary line.
 */
export function averageMetrics(results: MetricsResult[]): MetricsResult {
  if (results.length === 0) return { ndcg_at_k: 0, mrr: 0, recall_at_k: 0, k: 0 };
  let nd = 0;
  let mrr = 0;
  let recall = 0;
  for (const r of results) {
    nd += r.ndcg_at_k;
    mrr += r.mrr;
    recall += r.recall_at_k;
  }
  return {
    ndcg_at_k: nd / results.length,
    mrr: mrr / results.length,
    recall_at_k: recall / results.length,
    k: results[0]?.k ?? 0,
  };
}
