/**
 * Semantic retriever — adapter over the vector path
 * (`EmbeddingService.embed` + `VectorStore.search`).
 *
 * Wraps the existing semantic search machinery from `src/ai/interfaces.ts`;
 * DOES NOT reimplement vector NN logic. When no AI provider is configured
 * (the common case in tests, CI, and pre-`embed_repo` projects), this
 * retriever returns `[]` from every step — exactly mirroring trace-mcp's
 * existing "no AI provider, no semantic results" behaviour.
 *
 * Step mapping:
 *   - getContext   → embed the query (or stash `null` if no AI provider)
 *   - getCompletion→ run `vectorStore.search` against the embedding
 *   - getAnswer    → filter by `minScore` then trim to top-K
 *
 * Note on state: `getAnswer` does not receive the context, so the knobs
 * captured by `getContext` (`limit`, `minScore`) are stashed on the
 * instance. This means one retriever instance must process pipeline
 * calls serially — which is what `runRetriever` does. For concurrent
 * use, construct one retriever per call (factories are cheap).
 */
import type { EmbeddingService, VectorStore } from '../../ai/interfaces.js';
import type { BaseRetriever, RetrievedItem, RetrieverContext } from '../types.js';

/** Input shape for the semantic retriever. */
export interface SemanticQuery {
  /** Raw user query — embedded with the configured EmbeddingService. */
  text: string;
  /** Top-K cap applied by `getAnswer`. Default 20. */
  limit?: number;
  /**
   * Minimum cosine similarity (or whatever the vector store reports as
   * `score`) to keep a result. Default 0 — accept everything the store
   * returns. The vector path historically does no thresholding either.
   */
  minScore?: number;
}

export interface SemanticHit {
  /** Numeric symbol row id (matches `symbols.id`). */
  symbolId: number;
  /** Score from the vector store — provider-defined, higher is better. */
  score: number;
}

export type SemanticResult = RetrievedItem<SemanticHit>;

interface SemanticCtx {
  /** `null` when no AI provider is configured or the query was empty. */
  embedding: number[] | null;
  limit: number;
  minScore: number;
}

const DEFAULT_LIMIT = 20;

export class SemanticRetriever implements BaseRetriever<SemanticQuery, SemanticResult> {
  readonly name = 'semantic';

  // Captured by `getContext`, consumed by `getAnswer`.
  private lastMinScore = 0;
  private lastLimit = DEFAULT_LIMIT;

  constructor(
    private readonly embedding: EmbeddingService | null,
    private readonly vectorStore: VectorStore | null,
  ) {}

  async getContext(query: SemanticQuery): Promise<RetrieverContext<SemanticCtx>> {
    const text = (query.text ?? '').trim();
    const limit = query.limit ?? DEFAULT_LIMIT;
    const minScore = query.minScore ?? 0;
    this.lastLimit = limit;
    this.lastMinScore = minScore;

    // No AI provider configured (or empty query) — bail early. Subsequent
    // steps return [] without touching the vector store.
    if (!this.embedding || !this.vectorStore || !text) {
      return { query, data: { embedding: null, limit, minScore } };
    }

    // Pass 'query' so providers that distinguish indexing vs retrieval
    // (Voyage `input_type`, Vertex `task_type`) produce the right vector.
    const embedding = await this.embedding.embed(text, 'query');
    return { query, data: { embedding, limit, minScore } };
  }

  async getCompletion(context: RetrieverContext<unknown>): Promise<SemanticResult[]> {
    const ctx = context.data as SemanticCtx;
    if (!ctx.embedding || !this.vectorStore) return [];

    // Fetch limit*3 candidates so `getAnswer` has room to threshold-filter
    // without immediately starving the result list. Matches the pattern
    // used by `find_similar` in `src/tools/ai/ai-tools.ts`.
    const hits = this.vectorStore.search(ctx.embedding, ctx.limit * 3);

    return hits.map((hit) => ({
      id: String(hit.id),
      score: hit.score,
      source: 'embedding',
      payload: { symbolId: hit.id, score: hit.score },
    }));
  }

  async getAnswer(results: SemanticResult[]): Promise<SemanticResult[]> {
    // VectorStore.search returns hits in score order, but we re-sort
    // defensively — different implementations have historically
    // disagreed on direction. Then threshold-filter, then trim.
    const sorted = [...results].sort((a, b) => b.score - a.score);
    const filtered =
      this.lastMinScore > 0 ? sorted.filter((r) => r.score >= this.lastMinScore) : sorted;
    return filtered.slice(0, this.lastLimit);
  }
}

/** Factory — keeps `register()` call sites short. */
export function createSemanticRetriever(
  embedding: EmbeddingService | null,
  vectorStore: VectorStore | null,
): SemanticRetriever {
  return new SemanticRetriever(embedding, vectorStore);
}
