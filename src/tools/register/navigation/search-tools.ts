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
import { SEARCH_MODE_NAMES } from '../../../retrieval/modes/registry.js';
import { runNamedSearchMode } from '../retrieval.js';

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
    'Search symbols by name, kind, or text. Use instead of Grep for functions, classes, methods, variables. For raw text/comment search use search_text; for references to a known symbol use find_usages. Read-only. Returns JSON: { items: [{ symbol_id, name, kind, fqn, signature, file, line, score }], total, search_mode } — mode-specific shape when mode!=single. Supports `output_format: "toon"`.',
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
        .describe('Filter to symbols carrying this decorator/annotation/attribute'),
      fuzzy: z
        .boolean()
        .optional()
        .describe('Typo-tolerant search. Auto-enabled when exact search returns 0 results.'),
      fuzzy_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('[fuzzy] Min trigram similarity (default 0.3)'),
      max_edit_distance: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('[fuzzy] Max edit distance (default 3)'),
      semantic: z
        .enum(['auto', 'on', 'off', 'only'])
        .optional()
        .describe(
          'auto (default): hybrid if AI available. on: force hybrid. off: lexical-only. only: pure vector. Non-"off" needs an AI provider + one embed_repo run.',
        ),
      semantic_weight: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('[semantic] 0 = lexical only, 0.5 = balanced (default), 1 = vector only.'),
      // Per-channel fusion weights are not a call-site knob: they live in
      // ~/.trace-mcp/tuning.jsonc (written by `tune_weights`) and are picked up
      // automatically below. The nested object they used to need was the single
      // most expensive structure in this schema, paid by every client on every
      // session for a parameter almost nobody set (TRA-240).
      fusion: z
        .boolean()
        .optional()
        .describe(
          'Enable Signal Fusion — multi-channel WRR ranking across lexical (BM25), structural (PageRank), similarity (embeddings), and identity match. Weights come from `tune_weights`.',
        ),
      limit: z.number().int().min(1).max(500).optional().describe('Max results (default 20)'),
      offset: z.number().int().min(0).max(50000).optional().describe('Offset for pagination'),
      mode: z
        .enum(RETRIEVAL_MODES)
        .optional()
        .describe(
          'single (default): top-K. tiered: high/medium/low buckets. drill: scoped to drill_from. flat: raw FTS, no PageRank. get: exact lookup. Omit to auto-pick.',
        ),
      drill_from: z
        .string()
        .max(512)
        .optional()
        .describe('[mode="drill"] File path or symbol_id to restrict results to.'),
      retriever: z
        .enum(SEARCH_MODE_NAMES)
        .optional()
        .describe(
          'Run one named retrieval algorithm instead of the mode dispatcher. Ignores mode/filters/fuzzy/fusion; returns { retriever, items, total }.',
        ),
      detail_level: DetailLevelSchema,
      output_format: OutputFormatSchema.describe(
        '"json" (default) or "toon" (lossless, 30-60% fewer tokens). "markdown" behaves as json here.',
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
      mode,
      drill_from,
      retriever,
      detail_level,
      output_format,
    }) => {
      const encode = (payload: unknown): string =>
        output_format === 'toon' ? encodeResponse(payload, 'toon') : jh('search', payload);

      // Named-retriever path: bypasses the mode-based shaping dispatcher below
      // entirely, delegating straight to the shared `runNamedSearchMode` helper.
      if (retriever) {
        const result = await runNamedSearchMode(ctx, { query, mode: retriever, limit });
        if (!result.ok) {
          return {
            content: [
              {
                type: 'text',
                text: encode({
                  error: 'unknown_mode',
                  retriever: result.mode,
                  available: result.available,
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: encode({ retriever: result.mode, items: result.items, total: result.total }),
            },
          ],
        };
      }

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

      // When fusion is requested, weights come from per-repo tuning in
      // ~/.trace-mcp/tuning.jsonc (Phase 4b); absent that, the retriever's
      // built-in defaults apply.
      const effectiveFusionWeights = fusion
        ? (loadTunedWeights(projectRoot) ?? undefined)
        : undefined;

      // ─── Dispatch via SearchToolRetriever (plans P01 + P03) ────────
      // Every mode (get / flat / single / tiered / drill) now flows through
      // the BaseRetriever protocol. The retriever DELEGATES to the same
      // helpers used previously — no behavioural change. See
      // src/retrieval/retrievers/search-tool-retriever.ts and the equivalence
      // tests in src/retrieval/__tests__/search-tool-equivalence.test.ts.
      const searchToolRetriever = createSearchToolRetriever({
        store,
        vectorStore: vectorStore ?? null,
        embeddingService: embeddingService ?? null,
        reranker: reranker ?? null,
      });
      const retrieverResults = await runRetriever(searchToolRetriever, {
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
