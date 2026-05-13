/**
 * SearchToolRetriever — canonical `search` MCP tool wrapped in the
 * BaseRetriever<Q,R> protocol (plans P01 + P03).
 *
 * ## Why this exists
 *
 * The `search` MCP tool has accumulated five orthogonal behaviours over time:
 * lexical FTS, fuzzy fallback, semantic hybrid, signal fusion, and memoir-style
 * modes (single/tiered/drill/flat/get). Each one used to live in a different
 * place. This retriever is the SINGLE adapter that every code path going
 * through `search` now flows through, so the next person who wants to add a
 * cross-cutting concern (telemetry, ranking signal, debug hook) edits ONE
 * adapter — not the five branches scattered across the tool file.
 *
 * ## Behaviour preservation
 *
 * This is a behaviour-preserving refactor. The retriever DELEGATES to the same
 * underlying helpers the tool already uses:
 *   - `search()` from `src/tools/navigation/navigation.ts`
 *   - `runFlatSearch()` from `src/tools/navigation/search-dispatcher.ts`
 *   - `resolveExactLookup()` from `src/tools/navigation/search-dispatcher.ts`
 *   - `selectRetrievalMode()` from `src/ai/retrieval-modes.ts`
 *
 * The equivalence test (`__tests__/search-tool-equivalence.test.ts`) compares
 * direct calls vs the retriever path across 7+ query shapes and asserts
 * byte-identical top-K results.
 *
 * ## Three-step contract
 *
 * - `getContext`  → resolve the effective mode (explicit or heuristic) and
 *                   normalise inputs. No DB calls.
 * - `getCompletion`→ dispatch to flat / get / standard search. One DB pass.
 * - `getAnswer`    → identity (the tool layer handles projection/freshness/_meta).
 *
 * ## Why not multi-step ranking inside `getAnswer`?
 *
 * The `search` tool already has elaborate post-processing (projection to
 * `SearchResultItemProjected`, freshness enrichment, drill-filter, fusion
 * debug, subproject search, negative-evidence fallback). Pulling that into
 * `getAnswer` would tangle the retriever with MCP-specific concerns. The
 * retriever stops at "ranked result list"; the tool layer does the wrapping.
 */
import { selectRetrievalMode, type RetrievalMode } from '../../ai/retrieval-modes.js';
import type { EmbeddingService, RerankerService, VectorStore } from '../../ai/interfaces.js';
import type { Store } from '../../db/store.js';
import {
  search as runStandardSearch,
  type FusionSearchOptions,
  type SemanticOptions,
} from '../../tools/navigation/navigation.js';
import {
  runFlatSearch,
  resolveExactLookup,
  type ExactLookupResult,
  type FlatSearchFilters,
  type FlatSearchResult,
} from '../../tools/navigation/search-dispatcher.js';
import type { BaseRetriever, RetrieverContext } from '../types.js';

/** Top-level filters accepted by the search tool. */
export interface SearchToolFilters {
  kind?: string;
  language?: string;
  filePattern?: string;
  implements?: string;
  extends?: string;
  decorator?: string;
}

/** Memoir-style mode names, identical to the tool's Zod enum. */
export type SearchToolMode = RetrievalMode;

/** Query shape — superset of every flag the `search` MCP tool exposes. */
export interface SearchToolQuery {
  query: string;
  filters?: SearchToolFilters;
  limit?: number;
  offset?: number;
  fuzzy?: boolean;
  fuzzyThreshold?: number;
  maxEditDistance?: number;
  semantic?: SemanticOptions['semantic'];
  semanticWeight?: number;
  fusion?: boolean;
  fusionWeights?: FusionSearchOptions['weights'];
  fusionDebug?: boolean;
  mode?: SearchToolMode;
  drillFrom?: string;
}

/**
 * Result envelope returned by `getCompletion`.
 *
 * Mirrors the underlying `SearchResult` shape from `navigation.ts` plus the
 * mode-specific extensions:
 *   - flat mode → `kind: 'flat'`, result is `FlatSearchResult`
 *   - get  mode → `kind: 'get'`,  result is `{ item: ExactLookupResult | null }`
 *   - else      → `kind: 'standard'`, result is the `SearchResult` from
 *                 `runStandardSearch` (which carries items / total / search_mode
 *                 / fusion_debug / _warning / _error).
 *
 * The tool layer narrows on `kind` and renders accordingly.
 */
export type SearchToolResult =
  | { kind: 'flat'; effectiveMode: SearchToolMode; payload: FlatSearchResult }
  | { kind: 'get'; effectiveMode: 'get'; payload: { item: ExactLookupResult | null } }
  | {
      kind: 'standard';
      effectiveMode: SearchToolMode;
      payload: Awaited<ReturnType<typeof runStandardSearch>>;
    };

/** Dependency bundle — same things the tool registration already holds. */
export interface SearchToolDeps {
  store: Store;
  vectorStore: VectorStore | null;
  embeddingService: EmbeddingService | null;
  reranker: RerankerService | null;
}

interface NormalisedCtx {
  query: string;
  filters: SearchToolFilters;
  limit: number;
  offset: number;
  fuzzy?: boolean;
  fuzzyThreshold?: number;
  maxEditDistance?: number;
  semantic?: SemanticOptions['semantic'];
  semanticWeight?: number;
  fusion?: boolean;
  fusionWeights?: FusionSearchOptions['weights'];
  fusionDebug?: boolean;
  effectiveMode: SearchToolMode;
  drillFrom?: string;
}

/** Default top-K. Matches the tool's `limit ?? 20` fallback. */
const DEFAULT_LIMIT = 20;

export class SearchToolRetriever implements BaseRetriever<SearchToolQuery, SearchToolResult> {
  readonly name = 'search_tool';

  constructor(private readonly deps: SearchToolDeps) {}

  async getContext(query: SearchToolQuery): Promise<RetrieverContext<NormalisedCtx>> {
    const effectiveMode: SearchToolMode =
      query.mode ?? selectRetrievalMode(query.query, { drillFrom: query.drillFrom });
    return {
      query,
      data: {
        query: query.query,
        filters: query.filters ?? {},
        limit: query.limit ?? DEFAULT_LIMIT,
        offset: query.offset ?? 0,
        fuzzy: query.fuzzy,
        fuzzyThreshold: query.fuzzyThreshold,
        maxEditDistance: query.maxEditDistance,
        semantic: query.semantic,
        semanticWeight: query.semanticWeight,
        fusion: query.fusion,
        fusionWeights: query.fusionWeights,
        fusionDebug: query.fusionDebug,
        effectiveMode,
        drillFrom: query.drillFrom,
      },
    };
  }

  async getCompletion(context: RetrieverContext<unknown>): Promise<SearchToolResult[]> {
    const ctx = context.data as NormalisedCtx;

    // `get` mode: exact lookup, no search.
    if (ctx.effectiveMode === 'get') {
      const item = resolveExactLookup(this.deps.store, ctx.query);
      return [{ kind: 'get', effectiveMode: 'get', payload: { item } }];
    }

    // `flat` mode: raw FTS hits, skip PageRank/hybrid/fusion. Mirrors the
    // tool's pre-migration dispatch byte-for-byte.
    if (ctx.effectiveMode === 'flat') {
      const payload = await runFlatSearch(
        this.deps.store,
        ctx.query,
        ctx.filters,
        ctx.limit,
        ctx.offset,
      );
      return [{ kind: 'flat', effectiveMode: ctx.effectiveMode, payload }];
    }

    // Everything else (single, tiered, drill) routes through the standard
    // `search()` path. Tiered/drill post-processing happens in the tool layer.
    const payload = await runStandardSearch(
      this.deps.store,
      ctx.query,
      ctx.filters,
      ctx.limit,
      ctx.offset,
      {
        vectorStore: this.deps.vectorStore,
        embeddingService: this.deps.embeddingService,
        reranker: this.deps.reranker,
      },
      {
        fuzzy: ctx.fuzzy,
        fuzzyThreshold: ctx.fuzzyThreshold,
        maxEditDistance: ctx.maxEditDistance,
      },
      { semantic: ctx.semantic, semanticWeight: ctx.semanticWeight },
      ctx.fusion ? { fusion: true, weights: ctx.fusionWeights, debug: ctx.fusionDebug } : undefined,
    );
    return [{ kind: 'standard', effectiveMode: ctx.effectiveMode, payload }];
  }

  async getAnswer(results: SearchToolResult[]): Promise<SearchToolResult[]> {
    // Identity — the tool layer handles projection, freshness, drill-filter,
    // and _meta enrichment. Splitting that off into `getAnswer` would couple
    // the retriever to MCP/Zod concerns it has no business knowing about.
    return results;
  }
}

/** Factory — keeps tool registration call sites short. */
export function createSearchToolRetriever(deps: SearchToolDeps): SearchToolRetriever {
  return new SearchToolRetriever(deps);
}
