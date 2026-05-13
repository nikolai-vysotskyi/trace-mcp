/**
 * Lexical retriever — adapter over `searchFts` (`src/db/fts.ts`).
 *
 * Wraps the existing BM25/FTS5 path; DOES NOT reimplement search logic.
 * The point of this slice is to prove the 3-step protocol fits an
 * existing trace-mcp search path without behavioural drift — see the
 * golden test in `__tests__/lexical-retriever.test.ts`.
 *
 * Step mapping:
 *   - getContext   → parse the query (trim + capture filters + limit)
 *   - getCompletion→ call `searchFts` with the parsed terms
 *   - getAnswer    → trim to top-K (default 20)
 */
import type { FtsFilters, FtsResult } from '../../db/fts.js';
import { searchFts } from '../../db/fts.js';
import type { Store } from '../../db/store.js';
import type { BaseRetriever, RetrievedItem, RetrieverContext } from '../types.js';

/** Input shape for the lexical retriever. */
export interface LexicalQuery {
  /** Raw user query — passed straight to FTS5 after escaping. */
  text: string;
  /** Optional structural filters (kind / language / file path substring). */
  filters?: FtsFilters;
  /** Top-K cap applied by `getAnswer`. Default 20. */
  limit?: number;
  /** Pagination offset for FTS. Default 0. */
  offset?: number;
}

/** Output: scored FTS hit. */
export type LexicalResult = RetrievedItem<FtsResult>;

/** Internal context: what `getCompletion` needs. */
interface LexicalCtx {
  text: string;
  filters?: FtsFilters;
  limit: number;
  offset: number;
}

/** Default top-K. Mirrors `searchFts`'s own default. */
const DEFAULT_LIMIT = 20;

export class LexicalRetriever implements BaseRetriever<LexicalQuery, LexicalResult> {
  readonly name = 'lexical';

  constructor(private readonly store: Store) {}

  async getContext(query: LexicalQuery): Promise<RetrieverContext<LexicalCtx>> {
    const text = (query.text ?? '').trim();
    return {
      query,
      data: {
        text,
        filters: query.filters,
        limit: query.limit ?? DEFAULT_LIMIT,
        offset: query.offset ?? 0,
      },
    };
  }

  async getCompletion(context: RetrieverContext<unknown>): Promise<LexicalResult[]> {
    const ctx = context.data as LexicalCtx;
    if (!ctx.text) return [];

    // Delegate to the existing FTS path. We fetch `limit + offset` rows so
    // `getAnswer` can slice without re-querying.
    const rows = searchFts(this.store.db, ctx.text, ctx.limit + ctx.offset, 0, ctx.filters);

    // FTS5 bm25() returns negative scores (lower = better). Flip the sign
    // so callers get the trace-mcp convention "higher is better".
    return rows.map((row) => ({
      id: row.symbolIdStr,
      score: -row.rank,
      source: 'fts',
      payload: row,
    }));
  }

  async getAnswer(results: LexicalResult[]): Promise<LexicalResult[]> {
    // Already sorted by bm25 (ascending rank == descending score). Just
    // cap to the requested top-K. Mirrors what every caller of searchFts
    // does today.
    return results.slice(0, DEFAULT_LIMIT);
  }
}

/** Factory — keeps `register()` call sites short. */
export function createLexicalRetriever(store: Store): LexicalRetriever {
  return new LexicalRetriever(store);
}
