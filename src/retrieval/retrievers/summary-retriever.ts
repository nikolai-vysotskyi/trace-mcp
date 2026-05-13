/**
 * Summary retriever — composes `LexicalRetriever` and augments each hit
 * with the symbol's stored summary text (column `symbols.summary`).
 *
 * Goal: cheaper context than fetching full source, denser than just a
 * name + signature. Useful as the second stage in many "scan then read"
 * workflows.
 *
 * No new search algorithm — pure adapter over the existing lexical path
 * and the existing `Store.getSymbolBySymbolId` lookup.
 *
 * Step mapping:
 *   - getContext   → forward to lexical
 *   - getCompletion→ lexical search, then summary lookup per hit
 *   - getAnswer    → trim to top-K
 */
import type { Store } from '../../db/store.js';
import type { BaseRetriever, RetrievedItem, RetrieverContext } from '../types.js';
import { runRetriever } from '../types.js';
import type { LexicalQuery, LexicalResult } from './lexical-retriever.js';

export interface SummaryQuery {
  /** Raw user query — passed straight to the lexical retriever. */
  text: string;
  /** Top-K cap applied by `getAnswer`. Default 20. */
  limit?: number;
}

export interface SummaryHit {
  /** Symbol id (string form). */
  id: string;
  /** Display name. */
  name: string;
  /** Symbol kind (function/class/method/…). */
  kind: string;
  /** FQN if known. */
  fqn: string | null;
  /** The summary text from the symbols table, `null` if not yet computed. */
  summary: string | null;
  /** Original lexical score (BM25-derived, higher is better). */
  lexicalScore: number;
}

export type SummaryResult = RetrievedItem<SummaryHit>;

interface SummaryCtx {
  text: string;
  limit: number;
}

const DEFAULT_LIMIT = 20;

export class SummaryRetriever implements BaseRetriever<SummaryQuery, SummaryResult> {
  readonly name = 'summary';

  constructor(
    private readonly lexical: BaseRetriever<LexicalQuery, LexicalResult>,
    private readonly store: Store,
  ) {}

  async getContext(query: SummaryQuery): Promise<RetrieverContext<SummaryCtx>> {
    const text = (query.text ?? '').trim();
    return {
      query,
      data: {
        text,
        limit: query.limit ?? DEFAULT_LIMIT,
      },
    };
  }

  async getCompletion(context: RetrieverContext<unknown>): Promise<SummaryResult[]> {
    const ctx = context.data as SummaryCtx;
    if (!ctx.text) return [];

    const lexicalResults = await runRetriever(this.lexical, {
      text: ctx.text,
      limit: ctx.limit,
    });

    return lexicalResults.map((hit) => {
      const row = this.store.getSymbolBySymbolId(hit.id);
      return {
        id: hit.id,
        score: hit.score,
        source: 'summary',
        payload: {
          id: hit.id,
          name: hit.payload.name,
          kind: hit.payload.kind,
          fqn: hit.payload.fqn,
          summary: row?.summary ?? null,
          lexicalScore: hit.score,
        },
      };
    });
  }

  async getAnswer(results: SummaryResult[]): Promise<SummaryResult[]> {
    return results.slice(0, DEFAULT_LIMIT);
  }
}

/** Factory — keeps `register()` call sites short. */
export function createSummaryRetriever(
  lexical: BaseRetriever<LexicalQuery, LexicalResult>,
  store: Store,
): SummaryRetriever {
  return new SummaryRetriever(lexical, store);
}
