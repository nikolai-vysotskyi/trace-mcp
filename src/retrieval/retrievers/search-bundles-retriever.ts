/**
 * SearchBundlesRetriever — the `search_bundles` MCP tool wrapped in the
 * BaseRetriever<Q,R> protocol (plans P01 + P03).
 *
 * ## Why this exists
 *
 * `search_bundles` is the cross-index symbol lookup over pre-indexed
 * dependency bundles (e.g. React, Express). It is intentionally a separate
 * surface from `search` because:
 *   - it scans a *different* SQLite store per bundle, not the project DB;
 *   - it never participates in PageRank/fusion/semantic ranking — bundles
 *     are reference data, not project data;
 *   - bundles are loaded on demand and closed after the call.
 *
 * Wrapping it in BaseRetriever still pays off: future cross-cutting concerns
 * (telemetry, alt ranker, debug hook) edit ONE adapter instead of the inline
 * tool body.
 *
 * ## Behaviour preservation
 *
 * Pure delegation. The retriever calls `searchBundles()` from
 * `src/bundles.ts` with the loaded bundle handles already opened by the
 * caller. Bundle lifecycle (load + close) stays in the tool layer because
 * the bundle handle is a process-level resource (sqlite `Database`) and
 * leaking it out of the retriever would complicate ownership.
 *
 * `__tests__/search-bundles-equivalence.test.ts` compares direct calls vs
 * the retriever path across the shape matrix the tool advertises.
 *
 * ## Three-step contract
 *
 * - `getContext`  → normalise inputs. No DB calls.
 * - `getCompletion`→ delegate to `searchBundles()`. One DB pass per bundle.
 * - `getAnswer`   → identity (the tool layer wraps with `bundles_searched`
 *                   and handles the "no bundles installed" envelope).
 */
import { loadAllBundles, searchBundles } from '../../bundles.js';
import type { BaseRetriever, RetrieverContext } from '../types.js';

type LoadedBundle = ReturnType<typeof loadAllBundles>[number];

/** Query shape — mirrors the `search_bundles` tool's Zod input. */
export interface SearchBundlesQuery {
  query: string;
  kind?: string;
  limit?: number;
}

/** Single result item — matches the shape `searchBundles()` returns. */
export type SearchBundlesItem = ReturnType<typeof searchBundles>[number];

/** Result envelope — list of cross-bundle matches. */
export type SearchBundlesResult = SearchBundlesItem[];

/** Dependencies — the pre-loaded bundle handles (lifecycle owned by caller). */
export interface SearchBundlesDeps {
  bundles: LoadedBundle[];
}

interface NormalisedCtx {
  query: string;
  kind?: string;
  limit?: number;
}

export class SearchBundlesRetriever
  implements BaseRetriever<SearchBundlesQuery, SearchBundlesResult>
{
  readonly name = 'search_bundles_tool';

  constructor(private readonly deps: SearchBundlesDeps) {}

  async getContext(query: SearchBundlesQuery): Promise<RetrieverContext<NormalisedCtx>> {
    return {
      query,
      data: { query: query.query, kind: query.kind, limit: query.limit },
    };
  }

  async getCompletion(context: RetrieverContext<unknown>): Promise<SearchBundlesResult[]> {
    const ctx = context.data as NormalisedCtx;
    const results = searchBundles(this.deps.bundles, ctx.query, {
      kind: ctx.kind,
      limit: ctx.limit,
    });
    return [results];
  }

  async getAnswer(results: SearchBundlesResult[]): Promise<SearchBundlesResult[]> {
    // Identity — the tool layer wraps the list with `bundles_searched` and
    // the "no bundles installed" fallback, both MCP-specific concerns.
    return results;
  }
}

/** Factory — keeps tool registration call sites short. */
export function createSearchBundlesRetriever(deps: SearchBundlesDeps): SearchBundlesRetriever {
  return new SearchBundlesRetriever(deps);
}
