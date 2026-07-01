import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { optionalNonEmptyString } from '../_zod-helpers.js';
import {
  bucketize,
  RETRIEVAL_MODES,
  type RetrievalItem,
  selectRetrievalMode,
  TIERED_TOTAL_LIMIT,
} from '../../../ai/retrieval-modes.js';
import {
  aggregateFreshness,
  computeRepoFreshness,
  enrichItemsWithFreshness,
} from '../../../scoring/freshness.js';
import { computeRetrievalConfidence } from '../../../scoring/retrieval-confidence.js';
import { loadTunedWeights } from '../../../runtime/tuning.js';
import type { ServerContext } from '../../../server/types.js';
import { SubprojectManager } from '../../../subproject/manager.js';
import { type SearchResultItemProjected } from '../../navigation/navigation.js';
import { searchText } from '../../navigation/search-text.js';
import { suggestQueries } from '../../navigation/suggest.js';
import { fallbackSearch } from '../../navigation/zero-index.js';
import { buildNegativeEvidence } from '../../shared/evidence.js';
import {
  compactSearchItems,
  DetailLevelSchema,
  isMinimal,
  type SearchItemFull,
} from '../../_common/detail-level.js';
import { OutputFormatSchema, encodeResponse } from '../../_common/output-format.js';
import { createSearchToolRetriever } from '../../../retrieval/retrievers/search-tool-retriever.js';
import { runRetriever } from '../../../retrieval/types.js';

/**
 * Registers `search` and `suggest_queries` — the entry-point search tools.
 *
 * `search` is the multi-mode retrieval dispatcher (single/tiered/drill/flat/get,
 * fuzzy, semantic, fusion). Its underlying dispatch logic lives in
 * `src/tools/navigation/navigation.ts` and `src/retrieval/retrievers/search-tool-retriever.ts` —
 * this function is only the MCP registration wrapper (schema + response shaping).
 */
export function registerSearchTools(server: McpServer, ctx: ServerContext): void {
  const { store, projectRoot, j, jh, vectorStore, embeddingService, reranker } = ctx;

  server.tool(
    'search',
    'Search symbols by name, kind, or text. Use instead of Grep when looking for functions, classes, methods, or variables in source code. For raw text/string/comment search use search_text instead. For finding who references a known symbol use find_usages instead. Supports kind/language/file_pattern filters. Set fuzzy=true for typo-tolerant search (trigram + Levenshtein). For natural-language / conceptual queries set semantic="on" (requires an AI provider configured + embed_repo run once). Set fusion=true for Signal Fusion — multi-channel ranking (BM25 + PageRank + embeddings + identity match) via Weighted Reciprocal Rank fusion. Use mode to switch retrieval strategy: single (default — top-K, current behavior), tiered (high/medium/low buckets), drill (scope to a parent_path/parent_symbol_id subtree via drill_from), flat (raw FTS hits, cheapest), get (exact path/symbol_id lookup, no search). Read-only. Returns JSON: { items: [{ symbol_id, name, kind, fqn, signature, file, line, score }], total, search_mode } — mode-specific shape when mode!=single. Set `output_format: "toon"` for lossless TOON encoding — cheaper LLM tokens on tabular payloads.',
    {
      query: z.string().min(1).max(500).describe('Search query'),
      kind: z
        .string()
        .max(64)
        .optional()
        .describe('Filter by symbol kind (class, method, function, etc.)'),
      language: optionalNonEmptyString(64).describe('Filter by language'),
      file_pattern: optionalNonEmptyString(512).describe('Filter by file path pattern'),
      implements: z
        .string()
        .max(256)
        .optional()
        .describe('Filter to classes implementing this interface'),
      extends: z
        .string()
        .max(256)
        .optional()
        .describe('Filter to classes/interfaces extending this name'),
      decorator: z
        .string()
        .max(256)
        .optional()
        .describe(
          'Filter to symbols with this decorator/annotation/attribute (e.g. "Injectable", "Route", "Transactional")',
        ),
      fuzzy: z
        .boolean()
        .optional()
        .describe(
          'Enable fuzzy search (trigram + Levenshtein). Auto-enabled when exact search returns 0 results.',
        ),
      fuzzy_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Minimum Jaccard trigram similarity (default 0.3)'),
      max_edit_distance: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('Maximum Levenshtein edit distance (default 3)'),
      semantic: z
        .enum(['auto', 'on', 'off', 'only'])
        .optional()
        .describe(
          'Semantic mode: auto (default — hybrid if AI available), on (force hybrid), off (lexical-only), only (pure vector). Requires AI provider + embed_repo for non-"off" modes.',
        ),
      semantic_weight: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Hybrid fusion weight in [0,1]. 0 = lexical only, 0.5 = balanced (default), 1 = semantic only.',
        ),
      fusion: z
        .boolean()
        .optional()
        .describe(
          'Enable Signal Fusion Pipeline — multi-channel WRR ranking across lexical (BM25), structural (PageRank), similarity (embeddings), and identity (exact/prefix/segment match). Produces better results than single-channel search.',
        ),
      fusion_weights: z
        .object({
          lexical: z.number().min(0).max(1).optional(),
          structural: z.number().min(0).max(1).optional(),
          similarity: z.number().min(0).max(1).optional(),
          identity: z.number().min(0).max(1).optional(),
        })
        .optional()
        .describe(
          'Per-channel weights for fusion (auto-normalized). Defaults: lexical=0.4, structural=0.25, similarity=0.2, identity=0.15.',
        ),
      fusion_debug: z
        .boolean()
        .optional()
        .describe('Include per-channel rank contributions in fusion results.'),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 20)'),
      offset: z.number().int().min(0).max(50000).optional().describe('Offset for pagination'),
      mode: z
        .enum(RETRIEVAL_MODES)
        .optional()
        .describe(
          'Memoir-style retrieval mode: single (default — top-K), tiered (high/medium/low buckets), drill (scoped to drill_from), flat (raw FTS, no PageRank), get (exact lookup). Omit to auto-pick (path-shaped query → get, otherwise → single).',
        ),
      drill_from: z
        .string()
        .max(512)
        .optional()
        .describe(
          'Drill scope for mode="drill" — a file path or symbol_id. Results are restricted to the subtree rooted here.',
        ),
      detail_level: DetailLevelSchema,
      output_format: OutputFormatSchema.describe(
        'Output format. "json" (default) returns JSON; "toon" returns Token-Oriented Object Notation — 30-60% fewer tokens, lossless. "markdown" is unsupported here and behaves as json.',
      ),
    },
    async ({
      query,
      kind,
      language,
      file_pattern,
      limit,
      offset,
      implements: impl,
      extends: ext,
      decorator,
      fuzzy,
      fuzzy_threshold,
      max_edit_distance,
      semantic,
      semantic_weight,
      fusion,
      fusion_weights,
      fusion_debug,
      mode,
      drill_from,
      detail_level,
      output_format,
    }) => {
      const encode = (payload: unknown): string =>
        output_format === 'toon' ? encodeResponse(payload, 'toon') : jh('search', payload);
      // Resolve effective mode. Explicit `mode` wins; otherwise heuristic.
      // (Kept here so the zero-index / tiered branches below can branch on it
      // before the retriever runs. The retriever recomputes the same value
      // from the same inputs — verified by the equivalence test suite.)
      const effectiveMode = mode ?? selectRetrievalMode(query, { drillFrom: drill_from });

      // Zero-index fallback: if index is empty, use ripgrep. Must run BEFORE
      // the retriever — the retriever assumes an indexed store.
      const stats = store.getStats();
      if (stats.totalFiles === 0) {
        const fbResult = fallbackSearch(projectRoot, query, {
          filePattern: file_pattern,
          maxResults: limit ?? 20,
        });
        return {
          content: [
            {
              type: 'text',
              text: encode({
                ...fbResult,
                search_mode: 'zero_index_fallback',
                _hint: 'Index is empty. Run reindex to enable full symbol search.',
              }),
            },
          ],
        };
      }

      // For tiered mode, ensure we ask the underlying ranker for at least
      // enough results to fill all buckets; honor caller-specified `limit`
      // only when it is larger than the tiered total.
      const effectiveLimit =
        effectiveMode === 'tiered'
          ? Math.max(limit ?? TIERED_TOTAL_LIMIT, TIERED_TOTAL_LIMIT)
          : limit;

      // For drill mode, scope by file_pattern / parent prefix. We still run a
      // normal search but apply a drill filter on the way out.
      const drillScope = effectiveMode === 'drill' ? (drill_from ?? '') : '';

      // When fusion is requested without explicit weights, fall back to per-repo
      // tuned weights from ~/.trace-mcp/tuning.jsonc (Phase 4b). Explicit
      // `fusion_weights` from the call always wins.
      let effectiveFusionWeights = fusion_weights;
      if (fusion && !effectiveFusionWeights) {
        const tuned = loadTunedWeights(projectRoot);
        if (tuned) effectiveFusionWeights = tuned;
      }

      // ─── Dispatch via SearchToolRetriever (plans P01 + P03) ────────
      // Every mode (get / flat / single / tiered / drill) now flows through
      // the BaseRetriever protocol. The retriever DELEGATES to the same
      // helpers used previously — no behavioural change. See
      // src/retrieval/retrievers/search-tool-retriever.ts and the equivalence
      // tests in src/retrieval/__tests__/search-tool-equivalence.test.ts.
      const retriever = createSearchToolRetriever({
        store,
        vectorStore: vectorStore ?? null,
        embeddingService: embeddingService ?? null,
        reranker: reranker ?? null,
      });
      const retrieverResults = await runRetriever(retriever, {
        query,
        filters: {
          kind,
          language,
          filePattern: file_pattern,
          implements: impl,
          extends: ext,
          decorator,
        },
        limit: effectiveLimit ?? 20,
        offset: offset ?? 0,
        fuzzy,
        fuzzyThreshold: fuzzy_threshold,
        maxEditDistance: max_edit_distance,
        semantic,
        semanticWeight: semantic_weight,
        fusion,
        fusionWeights: effectiveFusionWeights,
        fusionDebug: fusion_debug,
        mode: effectiveMode,
        drillFrom: drill_from,
      });
      const retrieverResult = retrieverResults[0];

      // ─── get mode: exact lookup, no search ─────────────────────
      if (retrieverResult.kind === 'get') {
        const payload = {
          mode: 'get' as const,
          item: retrieverResult.payload.item,
        };
        return { content: [{ type: 'text', text: encode(payload) }] };
      }

      const result = retrieverResult.payload;
      // Project to AI-useful fields only — strips DB internals (id, file_id, byte offsets, etc.)
      const items: SearchResultItemProjected[] = result.items.map(({ symbol, file, score }) => {
        const item: SearchResultItemProjected = {
          symbol_id: symbol.symbol_id,
          name: symbol.name,
          kind: symbol.kind,
          fqn: symbol.fqn,
          signature: symbol.signature,
          summary: symbol.summary,
          file: file.path,
          line: symbol.line_start,
          score,
        };
        // Surface decorators/annotations/attributes from metadata
        if (symbol.metadata) {
          try {
            const meta = (
              typeof symbol.metadata === 'string' ? JSON.parse(symbol.metadata) : symbol.metadata
            ) as Record<string, unknown>;
            const decs =
              (meta.decorators as string[] | undefined) ??
              (meta.annotations as string[] | undefined) ??
              (meta.attributes as string[] | undefined);
            if (Array.isArray(decs) && decs.length > 0) item.decorators = decs;
          } catch {
            /* ignore malformed metadata */
          }
        }
        return item;
      });
      // ─── Drill filter: scope to the requested subtree before projection ──
      // Apply on the rich `items` so we can inspect file paths and symbol_ids.
      let modeFilteredItems = items;
      if (effectiveMode === 'drill' && drillScope) {
        modeFilteredItems = items.filter((it) => {
          // Drill scope can be a file path prefix OR a symbol_id prefix.
          if (it.file === drillScope || it.file.startsWith(`${drillScope}/`)) return true;
          if (it.file.startsWith(drillScope)) return true;
          if (it.symbol_id === drillScope || it.symbol_id.startsWith(`${drillScope}:`)) return true;
          return false;
        });
      }
      const projectedItems = isMinimal(detail_level)
        ? compactSearchItems(modeFilteredItems as SearchItemFull[])
        : modeFilteredItems;
      const response: Record<string, unknown> = {
        items: projectedItems,
        total: effectiveMode === 'drill' ? modeFilteredItems.length : result.total,
        search_mode: result.search_mode,
      };
      // Stamp the memoir-style mode label so callers can branch on shape.
      response.mode = effectiveMode;
      if (effectiveMode === 'tiered') {
        // Bucketize the projected items into high/medium/low slices. The
        // flat `items` array stays in place for back-compat with single-mode
        // callers; new callers prefer `buckets`.
        const bucketSource = (modeFilteredItems as unknown as RetrievalItem[]).slice(
          0,
          TIERED_TOTAL_LIMIT,
        );
        response.buckets = bucketize(bucketSource);
      }
      if (effectiveMode === 'drill') {
        response.parent = drillScope;
      }
      if (isMinimal(detail_level)) response.detail_level = 'minimal';
      if (result.fusion_debug) response.fusion_debug = result.fusion_debug;
      // Propagate fusion honesty signal so callers can tell whether the
      // semantic channel actually fired (or was silently skipped because
      // embeddings are not populated). See `_meta.fusion` in
      // `src/tools/navigation/navigation.ts`.
      if ('_meta' in result && result._meta?.fusion) {
        response._meta = {
          ...((response._meta as Record<string, unknown> | undefined) ?? {}),
          fusion: result._meta.fusion,
        };
      }
      // Propagate near-miss suggestions from fuzzy search so the caller has
      // concrete candidates to retry with on a zero-hit response.
      if ('_near_misses' in result && result._near_misses && result._near_misses.length > 0) {
        response._near_misses = result._near_misses;
      }
      if (items.length === 0) {
        // Auto-fallback: try text search when symbol search finds nothing
        const textResult = searchText(store, projectRoot, {
          query,
          filePattern: file_pattern,
          language,
          maxResults: Math.min(limit ?? 20, 10),
          contextLines: 1,
        });
        if (textResult.isOk() && textResult.value.matches.length > 0) {
          const tv = textResult.value;
          response.fallback_text_matches = tv.matches;
          response.fallback_total = tv.total_matches;
          response.search_mode = 'symbol_miss_text_fallback';
        } else {
          response.evidence = buildNegativeEvidence(
            stats.totalFiles,
            stats.totalSymbols,
            result.search_mode === 'fuzzy' || !!fuzzy,
            'search',
          );
        }
      }

      // Subproject layer: search across all subprojects when topology is enabled
      if (ctx.topoStore) {
        try {
          const subprojects = ctx.topoStore.getAllSubprojects();
          if (subprojects.length > 0) {
            const manager = new SubprojectManager(ctx.topoStore);
            const subResult = manager.subprojectSearch(
              query,
              { kind, language, filePattern: file_pattern },
              limit ?? 20,
              projectRoot,
            );
            if (subResult.items.length > 0) {
              response.subproject_results = subResult.items;
              response.subproject_repos_searched = subResult.repos_searched;
            }
          }
        } catch {
          /* subproject search is best-effort */
        }
      }

      // Attach per-item freshness + summary + retrieval confidence in _meta
      if (Array.isArray(response.items) && response.items.length > 0) {
        const items = response.items as Array<{
          file: string;
          score?: number;
          name?: string;
          fqn?: string | null;
          symbol_id?: string;
        }>;
        const enriched = enrichItemsWithFreshness(store, projectRoot, items);
        response.items = enriched.items;
        // Record retrieval event for self-tuning. No-op when ledger is null.
        if (ctx.rankingLedger) {
          ctx.rankingLedger.recordEvent({
            tool: 'search',
            query,
            topSymbolIds: items
              .slice(0, 10)
              .map((i) => i.symbol_id ?? '')
              .filter(Boolean),
            repo: projectRoot,
          });
        }
        // Augment summary with repo-level HEAD comparison when available.
        const repoFreshness = computeRepoFreshness(projectRoot, store);
        if (repoFreshness) {
          enriched.summary.repo_is_stale =
            enriched.summary.repo_is_stale || repoFreshness.repo_is_stale;
        }
        const top = enriched.items[0];
        const confidence = computeRetrievalConfidence({
          scores: enriched.items.map((i) => Number(i.score ?? 0)),
          topName: top?.name ?? null,
          topFqn: top?.fqn ?? null,
          query,
          freshnessSummary: enriched.summary,
        });
        response._meta = {
          ...((response._meta as Record<string, unknown> | undefined) ?? {}),
          freshness: enriched.summary,
          ...(repoFreshness ? { repo_freshness: repoFreshness } : {}),
          ...(confidence
            ? { confidence: confidence.confidence, confidence_signals: confidence.signals }
            : {}),
        };
      }
      return { content: [{ type: 'text', text: encode(response) }] };
    },
  );

  server.tool(
    'suggest_queries',
    'Onboarding helper: shows top imported files, most connected symbols (PageRank), language stats, and example tool calls. Call this first when exploring an unfamiliar project. For a structured project map use get_project_map instead. Read-only. Returns JSON: { topFiles, topSymbols, languageStats, exampleQueries }.',
    {},
    async () => {
      const result = suggestQueries(store);
      return { content: [{ type: 'text', text: j(result) }] };
    },
  );
}
