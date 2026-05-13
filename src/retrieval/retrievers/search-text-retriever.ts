/**
 * SearchTextRetriever — the `search_text` MCP tool wrapped in the
 * BaseRetriever<Q,R> protocol (plans P01 + P03).
 *
 * ## Why this exists
 *
 * `search_text` is the project's raw FTS surface — it scans indexed file
 * bodies (not symbols) with a literal-or-regex query, glob/language filters
 * and a wall-clock budget. This retriever is the SINGLE adapter every code
 * path going through `search_text` now flows through, so future cross-cutting
 * concerns (telemetry hooks, debug tracing, alt rankers) edit ONE adapter,
 * not the tool body.
 *
 * ## Behaviour preservation
 *
 * Pure delegation refactor. The retriever calls
 * `searchText()` from `src/tools/navigation/search-text.ts` with identical
 * arguments, so the wire-level result is byte-identical to the pre-migration
 * path. `__tests__/search-text-equivalence.test.ts` proves this across the
 * shape matrix the tool advertises (literal, regex, glob filter, language
 * filter, case sensitivity, empty result).
 *
 * ## Three-step contract
 *
 * - `getContext`  → normalise camelCase options. No DB/FS calls.
 * - `getCompletion`→ delegate to `searchText()`. One DB pass + bounded FS.
 * - `getAnswer`   → identity (the tool layer attaches negative-evidence
 *                   envelopes and is the only thing that knows about MCP
 *                   `_meta` wrappers).
 *
 * ## Result envelope
 *
 * The underlying helper returns `TraceMcpResult<SearchTextResult>` (Result-
 * like sum type). The retriever keeps that as the unit type so the tool
 * layer can branch on `isErr()` exactly as before.
 */
import type { Store } from '../../db/store.js';
import { searchText } from '../../tools/navigation/search-text.js';
import type { BaseRetriever, RetrieverContext } from '../types.js';

/** Query shape — mirrors the `search_text` tool's Zod input. */
export interface SearchTextQuery {
  query: string;
  isRegex?: boolean;
  filePattern?: string;
  language?: string;
  maxResults?: number;
  contextLines?: number;
  caseSensitive?: boolean;
  timeoutMs?: number;
}

/** Result envelope — the unmodified `TraceMcpResult` from the helper. */
export type SearchTextResult = ReturnType<typeof searchText>;

/** Dependencies — store for the file list and project root for path checks. */
export interface SearchTextDeps {
  store: Store;
  projectRoot: string;
}

interface NormalisedCtx {
  query: string;
  isRegex?: boolean;
  filePattern?: string;
  language?: string;
  maxResults?: number;
  contextLines?: number;
  caseSensitive?: boolean;
  timeoutMs?: number;
}

export class SearchTextRetriever implements BaseRetriever<SearchTextQuery, SearchTextResult> {
  readonly name = 'search_text_tool';

  constructor(private readonly deps: SearchTextDeps) {}

  async getContext(query: SearchTextQuery): Promise<RetrieverContext<NormalisedCtx>> {
    return {
      query,
      data: {
        query: query.query,
        isRegex: query.isRegex,
        filePattern: query.filePattern,
        language: query.language,
        maxResults: query.maxResults,
        contextLines: query.contextLines,
        caseSensitive: query.caseSensitive,
        timeoutMs: query.timeoutMs,
      },
    };
  }

  async getCompletion(context: RetrieverContext<unknown>): Promise<SearchTextResult[]> {
    const ctx = context.data as NormalisedCtx;
    const result = searchText(this.deps.store, this.deps.projectRoot, {
      query: ctx.query,
      isRegex: ctx.isRegex,
      filePattern: ctx.filePattern,
      language: ctx.language,
      maxResults: ctx.maxResults,
      contextLines: ctx.contextLines,
      caseSensitive: ctx.caseSensitive,
      timeoutMs: ctx.timeoutMs,
    });
    return [result];
  }

  async getAnswer(results: SearchTextResult[]): Promise<SearchTextResult[]> {
    // Identity — negative-evidence and `_meta` decoration stay in the tool
    // layer, which is the only thing that knows the MCP wire format.
    return results;
  }
}

/** Factory — keeps tool registration call sites short. */
export function createSearchTextRetriever(deps: SearchTextDeps): SearchTextRetriever {
  return new SearchTextRetriever(deps);
}
