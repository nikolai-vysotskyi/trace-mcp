/**
 * Hybrid retrieval for decisions (Task 9).
 *
 * `query_decisions` recall is FTS5-only. This module layers an embedding
 * similarity channel on top of the lexical (FTS5) channel and fuses them with
 * the same Weighted Reciprocal Rank fusion used for symbol `search`
 * (`signalFusion`). When no embedding service is configured the function is a
 * pure pass-through over the FTS5-ordered pool — the zero-dependency fallback.
 *
 * Flow:
 *   1. Caller FTS5-prefilters + filters a candidate pool (DecisionRow[]).
 *   2. lexical channel = pool order (FTS5 rank).
 *   3. similarity channel = cosine(query, decision text) rank (embeddings).
 *   4. optional reranker pass over the fused top-N.
 *
 * Embeddings are computed on the fly for the candidate pool — decisions are not
 * persistently embedded, so there's no index to keep in sync. The pool is
 * bounded (FTS5 prefilter limit), so the batch embed cost is small.
 */
import type { EmbeddingService, RerankerService } from '../ai/interfaces.js';
import { signalFusion } from '../scoring/signal-fusion.js';
import type { DecisionRow } from './decision-types.js';

export interface HybridDecisionOptions {
  /** The natural-language query (same string passed to FTS5). */
  query: string;
  /** FTS5-ordered candidate pool (best lexical match first). */
  pool: DecisionRow[];
  /** Embedding service; when null the function returns `pool` unchanged. */
  embeddingService?: EmbeddingService | null;
  /** Optional reranker for a final cross-encoder pass over the fused top-N. */
  reranker?: RerankerService | null;
  /** Final result cap. Default: pool length. */
  limit?: number;
  /** Per-channel fusion weights (lexical / similarity). */
  weights?: { lexical?: number; similarity?: number };
  /** AbortSignal forwarded to the embedding/rerank calls. */
  signal?: AbortSignal;
  /** How many fused candidates to feed the reranker. Default 20. */
  rerankTopN?: number;
}

/** The text we embed / rerank a decision on. Title carries the most signal. */
export function decisionEmbeddingText(d: DecisionRow): string {
  const title = d.title ?? '';
  const content = d.content ?? '';
  // Title is the highest-signal field; include a slice of content for recall.
  return `${title}\n${content}`.slice(0, 2000);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Hybrid-rank a candidate pool of decisions. Returns the re-ordered rows.
 * Falls back to the FTS5 pool order when no embedding service is available or
 * when the pool / query is empty.
 */
export async function hybridRankDecisions(opts: HybridDecisionOptions): Promise<DecisionRow[]> {
  const { query, pool } = opts;
  const limit = opts.limit ?? pool.length;
  // Fallbacks: nothing to fuse, or no embeddings → preserve FTS5 order.
  if (pool.length <= 1 || !query.trim() || !opts.embeddingService) {
    return pool.slice(0, limit);
  }

  // Embedding similarity channel.
  let similarityOrder: DecisionRow[] = [];
  try {
    const [queryVec, docVecs] = await Promise.all([
      opts.embeddingService.embed(query, 'query', opts.signal),
      opts.embeddingService.embedBatch(pool.map(decisionEmbeddingText), 'document', opts.signal),
    ]);
    similarityOrder = pool
      .map((d, i) => ({ d, sim: cosine(queryVec, docVecs[i] ?? []) }))
      .sort((a, b) => b.sim - a.sim)
      .map((x) => x.d);
  } catch {
    // Embedding failure → degrade to lexical-only ranking.
    return pool.slice(0, limit);
  }

  // Fuse lexical (pool order) + similarity via WRR. Ids are decision ids.
  const lexicalItems = pool.map((d) => ({ id: String(d.id), data: d }));
  const similarityItems = similarityOrder.map((d) => ({ id: String(d.id) }));
  const fused = signalFusion(
    {
      lexical: { items: lexicalItems },
      similarity: { items: similarityItems },
    },
    {
      weights: {
        lexical: opts.weights?.lexical ?? 0.5,
        similarity: opts.weights?.similarity ?? 0.5,
      },
    },
  );
  const byId = new Map(pool.map((d) => [String(d.id), d]));
  let ranked = fused.map((r) => byId.get(r.id)).filter((d): d is DecisionRow => d !== undefined);

  // Optional reranker pass over the fused top-N.
  if (opts.reranker) {
    const topN = Math.min(opts.rerankTopN ?? 20, ranked.length);
    const head = ranked.slice(0, topN);
    try {
      const scored = await opts.reranker.rerank(
        query,
        head.map((d) => ({ id: d.id, text: decisionEmbeddingText(d) })),
        topN,
      );
      const order = new Map(scored.map((s, i) => [s.id, i]));
      const reranked = [...head].sort(
        (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
      );
      ranked = [...reranked, ...ranked.slice(topN)];
    } catch {
      // Reranker failure → keep the fused order.
    }
  }

  return ranked.slice(0, limit);
}
