/**
 * SearchSessionsRetriever — the `search_sessions` MCP tool wrapped in the
 * BaseRetriever<Q,R> protocol (plans P01 + P03).
 *
 * ## Why this exists
 *
 * `search_sessions` is the FTS surface over indexed Claude Code / Claw Code
 * conversation transcripts. It is its own retrieval channel — entirely
 * separate from the project symbol index — because:
 *   - rows live in `decision_store.db`, not the project SQLite;
 *   - it answers a different question ("what did we discuss?") than the
 *     symbol search ("what code exists?");
 *   - it never participates in PageRank / fusion ranking; relevance is
 *     pure FTS5 `rank` with porter stemming.
 *
 * Wrapping it in BaseRetriever still pays off: future cross-cutting
 * concerns (telemetry, hybrid blending with code matches, debug hook) edit
 * ONE adapter, not the tool body.
 *
 * ## Behaviour preservation
 *
 * Pure delegation. The retriever calls `DecisionStore.searchSessions()`
 * with identical arguments.
 * `__tests__/search-sessions-equivalence.test.ts` proves the byte-identical
 * result across the shape matrix the tool advertises.
 *
 * ## Three-step contract
 *
 * - `getContext`  → normalise inputs. No DB calls.
 * - `getCompletion`→ delegate to `decisionStore.searchSessions()`. One DB pass.
 * - `getAnswer`   → identity (the tool layer wraps with `total_results`,
 *                   `sessions_indexed`, and handles the empty-index envelope).
 */
import type { DecisionStore, SessionSearchResult } from '../../memory/decision-store.js';
import type { BaseRetriever, RetrieverContext } from '../types.js';

/** Query shape — mirrors the `search_sessions` tool's Zod input. */
export interface SearchSessionsQuery {
  query: string;
  limit?: number;
  /**
   * Project filter passed through to FTS. Mirrors the existing tool body,
   * which always passes the current `projectRoot`.
   */
  projectRoot?: string;
}

/** Result envelope — the unmodified rows from `searchSessions()`. */
export type SearchSessionsResult = SessionSearchResult[];

/** Dependencies — the decision store carrying the FTS5 index. */
export interface SearchSessionsDeps {
  store: DecisionStore;
}

interface NormalisedCtx {
  query: string;
  limit?: number;
  projectRoot?: string;
}

export class SearchSessionsRetriever
  implements BaseRetriever<SearchSessionsQuery, SearchSessionsResult>
{
  readonly name = 'search_sessions_tool';

  constructor(private readonly deps: SearchSessionsDeps) {}

  async getContext(query: SearchSessionsQuery): Promise<RetrieverContext<NormalisedCtx>> {
    return {
      query,
      data: {
        query: query.query,
        limit: query.limit,
        projectRoot: query.projectRoot,
      },
    };
  }

  async getCompletion(context: RetrieverContext<unknown>): Promise<SearchSessionsResult[]> {
    const ctx = context.data as NormalisedCtx;
    const rows = this.deps.store.searchSessions(ctx.query, {
      project_root: ctx.projectRoot,
      limit: ctx.limit,
    });
    return [rows];
  }

  async getAnswer(results: SearchSessionsResult[]): Promise<SearchSessionsResult[]> {
    // Identity — the tool layer wraps with `total_results`, `sessions_indexed`,
    // and the empty-index envelope, all MCP-specific concerns.
    return results;
  }
}

/** Factory — keeps tool registration call sites short. */
export function createSearchSessionsRetriever(deps: SearchSessionsDeps): SearchSessionsRetriever {
  return new SearchSessionsRetriever(deps);
}
