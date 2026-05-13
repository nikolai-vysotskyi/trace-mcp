/**
 * Hybrid retriever — composes `LexicalRetriever` + `SemanticRetriever` via
 * Reciprocal Rank Fusion (RRF).
 *
 * Pure composition over P01 adapters; DOES NOT introduce a new search
 * algorithm. When the semantic side is unavailable (no AI provider,
 * pre-`embed_repo` projects), the retriever degrades gracefully to
 * lexical-only — matching trace-mcp's existing "soft degradation" pattern.
 *
 * ## RRF
 *
 * For each candidate the score is the sum across channels of
 * `1 / (k + rank)`, where `rank` is 1-based within that channel and `k`
 * is a smoothing constant (60 is the canonical default from the
 * Cormack/Clarke/Buettcher 2009 paper). Items that appear in only one
 * channel still get a non-zero RRF score; items present in both rise to
 * the top.
 *
 * Step mapping:
 *   - getContext   → stash the query (knobs handed to the inner retrievers)
 *   - getCompletion→ run both inner retrievers and fuse their rankings
 *   - getAnswer    → trim to top-K
 */
import type { BaseRetriever, RetrievedItem, RetrieverContext } from '../types.js';
import { runRetriever } from '../types.js';
import type { LexicalQuery, LexicalResult } from './lexical-retriever.js';
import type { SemanticQuery, SemanticResult } from './semantic-retriever.js';

export interface HybridQuery {
  /** Raw user query. Passed to both inner retrievers. */
  text: string;
  /** Top-K cap applied by `getAnswer`. Default 20. */
  limit?: number;
  /** RRF smoothing constant. Default 60. */
  rrfK?: number;
}

/**
 * Output of fusion. `payload.channels` records which retrievers contributed
 * and at what rank — useful for telemetry and debugging the fusion math.
 */
export interface HybridHit {
  /** The original `id` from the underlying retriever — symbol_id string. */
  id: string;
  /** RRF score (always positive). Higher is better. */
  rrfScore: number;
  /** Per-channel rank contributions (1-based). */
  channels: { lexical?: number; semantic?: number };
}

export type HybridResult = RetrievedItem<HybridHit>;

interface HybridCtx {
  text: string;
  limit: number;
  rrfK: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_RRF_K = 60;

export class HybridRetriever implements BaseRetriever<HybridQuery, HybridResult> {
  readonly name = 'hybrid';

  constructor(
    private readonly lexical: BaseRetriever<LexicalQuery, LexicalResult>,
    /**
     * Semantic side is nullable. When `null`, hybrid degrades to lexical-only.
     * This matches the common case where no AI provider is configured.
     */
    private readonly semantic: BaseRetriever<SemanticQuery, SemanticResult> | null,
  ) {}

  async getContext(query: HybridQuery): Promise<RetrieverContext<HybridCtx>> {
    const text = (query.text ?? '').trim();
    return {
      query,
      data: {
        text,
        limit: query.limit ?? DEFAULT_LIMIT,
        rrfK: query.rrfK ?? DEFAULT_RRF_K,
      },
    };
  }

  async getCompletion(context: RetrieverContext<unknown>): Promise<HybridResult[]> {
    const ctx = context.data as HybridCtx;
    if (!ctx.text) return [];

    // Fetch limit*3 from each channel so RRF has enough overlap material.
    const fetchK = ctx.limit * 3;
    const lexicalResults = await runRetriever(this.lexical, {
      text: ctx.text,
      limit: fetchK,
    });
    const semanticResults = this.semantic
      ? await runRetriever(this.semantic, { text: ctx.text, limit: fetchK })
      : [];

    return fuseRrf(lexicalResults, semanticResults, ctx.rrfK);
  }

  async getAnswer(results: HybridResult[]): Promise<HybridResult[]> {
    // Already sorted by RRF score in `fuseRrf`. Just trim.
    return results.slice(0, DEFAULT_LIMIT);
  }
}

/**
 * Reciprocal Rank Fusion across the two channels.
 *
 * Exported for the unit test — keeps the math testable without standing
 * up a SQLite database.
 */
export function fuseRrf(
  lexical: LexicalResult[],
  semantic: SemanticResult[],
  k: number,
): HybridResult[] {
  const accum = new Map<string, HybridHit>();

  for (let i = 0; i < lexical.length; i++) {
    const r = lexical[i];
    const rank = i + 1;
    const score = 1 / (k + rank);
    const prev = accum.get(r.id);
    if (prev) {
      prev.rrfScore += score;
      prev.channels.lexical = rank;
    } else {
      accum.set(r.id, { id: r.id, rrfScore: score, channels: { lexical: rank } });
    }
  }

  for (let i = 0; i < semantic.length; i++) {
    const r = semantic[i];
    const rank = i + 1;
    const score = 1 / (k + rank);
    const prev = accum.get(r.id);
    if (prev) {
      prev.rrfScore += score;
      prev.channels.semantic = rank;
    } else {
      accum.set(r.id, { id: r.id, rrfScore: score, channels: { semantic: rank } });
    }
  }

  return [...accum.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map((hit) => ({
      id: hit.id,
      score: hit.rrfScore,
      source: 'hybrid',
      payload: hit,
    }));
}

/** Factory — keeps `register()` call sites short. */
export function createHybridRetriever(
  lexical: BaseRetriever<LexicalQuery, LexicalResult>,
  semantic: BaseRetriever<SemanticQuery, SemanticResult> | null,
): HybridRetriever {
  return new HybridRetriever(lexical, semantic);
}
