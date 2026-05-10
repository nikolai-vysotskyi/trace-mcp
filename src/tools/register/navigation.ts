import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { optionalNonEmptyString } from './_zod-helpers.js';
import { formatToolError } from '../../errors.js';
import {
  bucketize,
  RETRIEVAL_MODES,
  type RetrievalItem,
  selectRetrievalMode,
  TIERED_TOTAL_LIMIT,
} from '../../ai/retrieval-modes.js';
import { decisionsForImpact } from '../../memory/enrichment.js';
import { computeAdaptiveBudget } from '../../scoring/adaptive-budget.js';
import {
  aggregateFreshness,
  computeFileFreshness,
  computeRepoFreshness,
  enrichItemsWithFreshness,
} from '../../scoring/freshness.js';
import { renderItemsMarkdown, renderSectionsMarkdown } from '../../scoring/markdown-render.js';
import { computeRetrievalConfidence } from '../../scoring/retrieval-confidence.js';
import { loadTunedWeights } from '../../runtime/tuning.js';
import type { ServerContext } from '../../server/types.js';
import { SubprojectManager } from '../../subproject/manager.js';
import { getChangeImpact } from '../analysis/impact.js';
import { getFeatureContext } from '../navigation/context.js';
import { getContextBundle } from '../navigation/context-bundle.js';
import {
  getFileOutline,
  getSymbol,
  type SearchResultItemProjected,
  search,
} from '../navigation/navigation.js';
import { getRelatedSymbols } from '../navigation/related.js';
import { searchText } from '../navigation/search-text.js';
import { suggestQueries } from '../navigation/suggest.js';
import { getTaskContext } from '../navigation/task-context.js';
import { fallbackOutline, fallbackSearch } from '../navigation/zero-index.js';
import { CHANGE_IMPACT_METHODOLOGY } from '../shared/confidence.js';
import { buildNegativeEvidence } from '../shared/evidence.js';
import {
  compactOutlineSymbols,
  compactSearchItems,
  DetailLevelSchema,
  isMinimal,
  type SearchItemFull,
} from '../_common/detail-level.js';
import { searchFts as ftsSearch } from '../../db/fts.js';
import type { FileRow, Store, SymbolRow } from '../../db/store.js';

// ─── Retrieval-mode helpers ──────────────────────────────────────────
// Lightweight building blocks for the memoir-style retrieval modes
// wired into the `search` tool below. Kept at module scope so the test
// suite can exercise them in isolation if needed in the future.

interface FlatSearchFilters {
  kind?: string;
  language?: string;
  filePattern?: string;
  implements?: string;
  extends?: string;
  decorator?: string;
}

interface FlatSearchResult {
  items: { symbol: SymbolRow; file: FileRow; score: number }[];
  total: number;
  search_mode: 'flat';
  /** Always undefined for flat mode — present only so the union type stays
   *  assignment-compatible with `SearchResult.fusion_debug`. */
  fusion_debug?: undefined;
}

/**
 * `flat` mode entry point: BM25 hits, no PageRank / hybrid / fusion enrichment.
 * Returns a result object shaped like {@link search}'s output so the rest of
 * the tool pipeline (projection, freshness, _meta) can treat it uniformly.
 */
async function runFlatSearch(
  store: Store,
  query: string,
  filters: FlatSearchFilters,
  limit: number,
  offset: number,
): Promise<FlatSearchResult> {
  const ftsResults = ftsSearch(
    store.db,
    query,
    limit + offset + 20,
    0,
    filters.kind || filters.language || filters.filePattern
      ? { kind: filters.kind, language: filters.language, filePattern: filters.filePattern }
      : undefined,
  );
  if (ftsResults.length === 0) {
    return { items: [], total: 0, search_mode: 'flat' };
  }

  const symbolNumIds = ftsResults.map((r) => r.symbolId);
  const symMap = store.getSymbolsByIds(symbolNumIds);
  const fileIds = [...new Set(ftsResults.map((r) => r.fileId))];
  const fileMap = store.getFilesByIds(fileIds);

  const minRank = Math.min(...ftsResults.map((r) => r.rank));
  const maxRank = Math.max(...ftsResults.map((r) => r.rank));
  const rankSpread = maxRank - minRank || 1;

  const heritage = filters.implements || filters.extends;
  const decorator = filters.decorator;

  const items: { symbol: SymbolRow; file: FileRow; score: number }[] = [];
  for (const r of ftsResults) {
    const symbol = symMap.get(r.symbolId);
    if (!symbol) continue;
    const file = fileMap.get(symbol.file_id);
    if (!file) continue;

    if ((heritage || decorator) && symbol.metadata) {
      try {
        const meta = (
          typeof symbol.metadata === 'string' ? JSON.parse(symbol.metadata) : symbol.metadata
        ) as Record<string, unknown>;
        if (filters.implements) {
          const impl = meta.implements;
          if (!Array.isArray(impl) || !(impl as string[]).includes(filters.implements)) continue;
        }
        if (filters.extends) {
          const ext = meta.extends;
          const arr = Array.isArray(ext) ? (ext as string[]) : typeof ext === 'string' ? [ext] : [];
          if (!arr.includes(filters.extends)) continue;
        }
        if (decorator) {
          const decs =
            (meta.decorators as string[] | undefined) ??
            (meta.annotations as string[] | undefined) ??
            (meta.attributes as string[] | undefined);
          if (
            !Array.isArray(decs) ||
            !decs.some(
              (d) =>
                d === decorator || d.endsWith(`.${decorator}`) || d.startsWith(`${decorator}(`),
            )
          )
            continue;
        }
      } catch {
        /* malformed metadata → skip */
        continue;
      }
    } else if (heritage || decorator) {
      continue;
    }

    // Normalize BM25 (negative, lower=better) to a 0..1 score.
    const score = 1 - (r.rank - minRank) / rankSpread;
    items.push({ symbol, file, score });
  }

  const total = items.length;
  const sliced = items.slice(offset, offset + limit);
  return { items: sliced, total, search_mode: 'flat' };
}

/**
 * `get` mode entry point: exact symbol_id or file path lookup. No search.
 *
 * - If the query parses as a symbol_id (contains `:` and matches the lang:path:line:col:name shape),
 *   we look it up by symbol_id first, then by FQN.
 * - If the query looks like a file path, we return the first symbol of that file as a representative.
 * - Otherwise (the heuristic flagged it as path-shaped but nothing matched), returns null.
 */
function resolveExactLookup(
  store: Store,
  query: string,
): {
  symbol_id: string;
  name: string;
  kind: string;
  fqn: string | null;
  file: string;
  line: number | null;
} | null {
  // Symbol-id shape first.
  const bySymbolId = store.getSymbolBySymbolId(query);
  if (bySymbolId) {
    const file = store.getFileById(bySymbolId.file_id);
    if (file) {
      return {
        symbol_id: bySymbolId.symbol_id,
        name: bySymbolId.name,
        kind: bySymbolId.kind,
        fqn: bySymbolId.fqn,
        file: file.path,
        line: bySymbolId.line_start,
      };
    }
  }

  // FQN fallback (lets `get` resolve dotted names).
  const byFqn = store.getSymbolByFqn(query);
  if (byFqn) {
    const file = store.getFileById(byFqn.file_id);
    if (file) {
      return {
        symbol_id: byFqn.symbol_id,
        name: byFqn.name,
        kind: byFqn.kind,
        fqn: byFqn.fqn,
        file: file.path,
        line: byFqn.line_start,
      };
    }
  }

  // File-path shape: return the file's first ranked symbol as a representative.
  const file = store.getFile(query);
  if (file) {
    const syms = store.getSymbolsByFile(file.id);
    const first = syms[0];
    if (first) {
      return {
        symbol_id: first.symbol_id,
        name: first.name,
        kind: first.kind,
        fqn: first.fqn,
        file: file.path,
        line: first.line_start,
      };
    }
  }

  return null;
}

export function registerNavigationTools(server: McpServer, ctx: ServerContext): void {
  const {
    store,
    projectRoot,
    guardPath,
    j,
    jh,
    savings,
    vectorStore,
    embeddingService,
    reranker,
    markExplored,
    decisionStore,
  } = ctx;

  // --- Level 1 Navigation Tools ---

  server.tool(
    'get_symbol',
    'Look up a symbol by symbol_id or FQN and return its source code. Use instead of Read when you need one specific function/class/method — returns only the symbol, not the whole file. For multiple symbols at once, prefer get_context_bundle. Read-only. Returns JSON: { symbol_id, name, kind, fqn, signature, file, line_start, line_end, source }.',
    {
      symbol_id: optionalNonEmptyString(512).describe('The symbol_id to look up'),
      fqn: optionalNonEmptyString(512).describe('The fully qualified name to look up'),
      max_lines: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .describe('Truncate source to this many lines (omit for full source)'),
    },
    async ({ symbol_id, fqn, max_lines }) => {
      const result = getSymbol(store, projectRoot, {
        symbolId: symbol_id,
        fqn,
        maxLines: max_lines,
      });
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      }
      const { symbol, file, source, truncated } = result.value;
      markExplored(file.path);
      // Phase 4a: attribute this read to a recent ranked retrieval event when possible.
      ctx.rankingLedger?.recordAcceptance(projectRoot, symbol.symbol_id);
      const freshness = computeFileFreshness(projectRoot, file);
      const summary = aggregateFreshness([freshness]);
      const confidence = computeRetrievalConfidence({
        scores: [1],
        topName: symbol.name,
        topFqn: symbol.fqn ?? null,
        query: symbol.name,
        freshnessSummary: summary,
      });
      return {
        content: [
          {
            type: 'text',
            text: jh('get_symbol', {
              symbol_id: symbol.symbol_id,
              name: symbol.name,
              kind: symbol.kind,
              fqn: symbol.fqn,
              signature: symbol.signature,
              summary: symbol.summary,
              file: file.path,
              line_start: symbol.line_start,
              line_end: symbol.line_end,
              source,
              ...(truncated ? { truncated: true } : {}),
              _freshness: freshness,
              _meta: {
                freshness: summary,
                ...(confidence
                  ? {
                      confidence: confidence.confidence,
                      confidence_signals: confidence.signals,
                    }
                  : {}),
              },
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'search',
    'Search symbols by name, kind, or text. Use instead of Grep when looking for functions, classes, methods, or variables in source code. For raw text/string/comment search use search_text instead. For finding who references a known symbol use find_usages instead. Supports kind/language/file_pattern filters. Set fuzzy=true for typo-tolerant search (trigram + Levenshtein). For natural-language / conceptual queries set semantic="on" (requires an AI provider configured + embed_repo run once). Set fusion=true for Signal Fusion — multi-channel ranking (BM25 + PageRank + embeddings + identity match) via Weighted Reciprocal Rank fusion. Use mode to switch retrieval strategy: single (default — top-K, current behavior), tiered (high/medium/low buckets), drill (scope to a parent_path/parent_symbol_id subtree via drill_from), flat (raw FTS hits, cheapest), get (exact path/symbol_id lookup, no search). Read-only. Returns JSON: { items: [{ symbol_id, name, kind, fqn, signature, file, line, score }], total, search_mode } — mode-specific shape when mode!=single.',
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
    }) => {
      // Resolve effective mode. Explicit `mode` wins; otherwise heuristic.
      const effectiveMode = mode ?? selectRetrievalMode(query, { drillFrom: drill_from });

      // ─── get mode: exact lookup, no search ─────────────────────
      if (effectiveMode === 'get') {
        const lookup = resolveExactLookup(store, query);
        const payload = {
          mode: 'get' as const,
          item: lookup,
        };
        return { content: [{ type: 'text', text: jh('search', payload) }] };
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
      // Zero-index fallback: if index is empty, use ripgrep
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
              text: jh('search', {
                ...fbResult,
                search_mode: 'zero_index_fallback',
                _hint: 'Index is empty. Run reindex to enable full symbol search.',
              }),
            },
          ],
        };
      }

      // When fusion is requested without explicit weights, fall back to per-repo
      // tuned weights from ~/.trace-mcp/tuning.jsonc (Phase 4b). Explicit
      // `fusion_weights` from the call always wins.
      let effectiveFusionWeights = fusion_weights;
      if (fusion && !effectiveFusionWeights) {
        const tuned = loadTunedWeights(projectRoot);
        if (tuned) effectiveFusionWeights = tuned;
      }
      // ─── flat mode: raw FTS hits, skip PageRank/hybrid/fusion ──
      // We still construct a `result` shaped like the regular search output
      // so the downstream projection / freshness / subproject layers work
      // uniformly. The key difference: scores reflect BM25 only.
      const result =
        effectiveMode === 'flat'
          ? await runFlatSearch(
              store,
              query,
              {
                kind,
                language,
                filePattern: file_pattern,
                implements: impl,
                extends: ext,
                decorator,
              },
              effectiveLimit ?? 20,
              offset ?? 0,
            )
          : await search(
              store,
              query,
              {
                kind,
                language,
                filePattern: file_pattern,
                implements: impl,
                extends: ext,
                decorator,
              },
              effectiveLimit ?? 20,
              offset ?? 0,
              { vectorStore, embeddingService, reranker },
              { fuzzy, fuzzyThreshold: fuzzy_threshold, maxEditDistance: max_edit_distance },
              { semantic, semanticWeight: semantic_weight },
              fusion
                ? { fusion: true, weights: effectiveFusionWeights, debug: fusion_debug }
                : undefined,
            );
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
      return { content: [{ type: 'text', text: jh('search', response) }] };
    },
  );

  server.tool(
    'get_outline',
    "Get all symbols for a file (signatures only, no bodies). Use instead of Read to understand a file before editing — much cheaper in tokens. For reading one symbol's source, follow up with get_symbol. Read-only. Returns JSON: { path, language, symbols: [{ symbolId, name, kind, signature, lineStart, lineEnd }] }.",
    {
      path: z.string().max(512).describe('Relative file path'),
      detail_level: DetailLevelSchema,
    },
    async ({ path: filePath, detail_level }) => {
      const blocked = guardPath(filePath);
      if (blocked) return blocked;

      // Zero-index fallback: if index is empty, use regex-based extraction
      const stats = store.getStats();
      if (stats.totalFiles === 0) {
        try {
          const fbResult = fallbackOutline(projectRoot, filePath);
          return {
            content: [
              {
                type: 'text',
                text: jh('get_outline', {
                  ...fbResult,
                  _hint: 'Index is empty. Run reindex to enable full symbol extraction.',
                }),
              },
            ],
          };
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: j({ error: 'File not found or unreadable (index is empty)', path: filePath }),
              },
            ],
            isError: true,
          };
        }
      }

      const result = getFileOutline(store, filePath);
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      }
      markExplored(filePath);
      const fileRow = store.getFile(result.value.path);
      const freshness = fileRow ? computeFileFreshness(projectRoot, fileRow) : 'fresh';
      const summary = aggregateFreshness([freshness]);
      const confidence = computeRetrievalConfidence({
        scores: [1],
        freshnessSummary: summary,
      });
      const projectedSymbols = isMinimal(detail_level)
        ? compactOutlineSymbols(result.value.symbols)
        : result.value.symbols;
      const outlineWithFreshness = {
        path: result.value.path,
        language: result.value.language,
        symbols: projectedSymbols,
        ...(isMinimal(detail_level)
          ? { detail_level: 'minimal' as const }
          : {
              _freshness: freshness,
              _meta: {
                freshness: summary,
                ...(confidence
                  ? { confidence: confidence.confidence, confidence_signals: confidence.signals }
                  : {}),
              },
            }),
      };
      return { content: [{ type: 'text', text: jh('get_outline', outlineWithFreshness) }] };
    },
  );

  server.tool(
    'get_change_impact',
    'Full change impact report: risk score + mitigations, breaking change detection, enriched dependents (complexity, coverage, exports), module groups, affected tests, co-change hidden couplings. Supports diff-aware mode via symbol_ids to scope analysis to only changed symbols. Use before modifying code to understand blast radius. For quick risk assessment without full report, use assess_change_risk instead. Read-only. Returns JSON: { risk, dependents, affectedTests, breakingChanges, totalAffected }.',
    {
      file_path: optionalNonEmptyString(512).describe('Relative file path to analyze'),
      symbol_id: optionalNonEmptyString(512).describe('Symbol ID to analyze'),
      fqn: z
        .string()
        .max(512)
        .optional()
        .describe('Fully qualified name to analyze (alternative to symbol_id)'),
      symbol_ids: z
        .array(z.string().max(512))
        .max(50)
        .optional()
        .describe(
          'Diff-aware: only analyze impact of these specific symbols (e.g. from get_changed_symbols)',
        ),
      decorator_filter: z
        .string()
        .max(256)
        .optional()
        .describe(
          'Filter dependents to only those with this decorator/annotation/attribute (e.g. "Route", "Transactional", "csrf_protect")',
        ),
      depth: z.number().int().min(1).max(20).optional().describe('Max traversal depth (default 3)'),
      max_dependents: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('Cap on returned dependents (default 200)'),
    },
    async ({ file_path, symbol_id, fqn, symbol_ids, decorator_filter, depth, max_dependents }) => {
      if (file_path) {
        const blocked = guardPath(file_path);
        if (blocked) return blocked;
      }
      const result = getChangeImpact(
        store,
        {
          filePath: file_path,
          symbolId: symbol_id,
          fqn,
          symbolIds: symbol_ids,
          decoratorFilter: decorator_filter,
        },
        depth ?? 3,
        max_dependents ?? 200,
        projectRoot,
      );
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      }
      const includeMethodology =
        result.value.totalAffected === 0 ||
        result.value.risk?.level === 'high' ||
        result.value.risk?.level === 'critical';
      const payload: Record<string, unknown> = includeMethodology
        ? { ...result.value, _methodology: CHANGE_IMPACT_METHODOLOGY }
        : { ...result.value };
      // Enrich with linked decisions (code-aware memory)
      if (decisionStore) {
        const linkedDecisions = decisionsForImpact(
          decisionStore,
          projectRoot,
          { symbolId: symbol_id ?? fqn, filePath: file_path },
          result.value.dependents?.map((d) => d.path),
        );
        if (linkedDecisions.length > 0) {
          payload.linked_decisions = linkedDecisions;
        }
      }
      return { content: [{ type: 'text', text: jh('get_change_impact', payload) }] };
    },
  );

  server.tool(
    'get_feature_context',
    'Search code by keyword/topic → returns ranked source code snippets within a token budget. Use when you need to READ actual code for a concept or feature. For structured task context with tests and entry points, use get_task_context instead. For symbol metadata without source, use search. Read-only. Returns JSON (default) or Markdown: { items: [{ symbol_id, name, file, source, score }], token_usage } | { content: "...markdown..." }.',
    {
      description: z
        .string()
        .min(1)
        .max(2000)
        .describe('Natural language description of the feature to find context for'),
      token_budget: z
        .number()
        .int()
        .min(100)
        .max(100000)
        .optional()
        .describe('Max tokens for assembled context (default 4000)'),
      output_format: z
        .enum(['json', 'markdown'])
        .optional()
        .describe(
          'Output format. "json" (default) returns structured items; "markdown" returns LLM-friendly fenced code blocks (~15-20% token savings, easier for the model to read).',
        ),
    },
    async ({ description, token_budget, output_format }) => {
      const budgetState = {
        totalCalls: savings.getSessionStats().total_calls,
        totalRawTokens: savings.getSessionStats().total_raw_tokens,
      };
      const adaptive = computeAdaptiveBudget('get_feature_context', budgetState, token_budget);
      const result = getFeatureContext(store, projectRoot, description, adaptive.budget);
      if (result.items.length === 0) {
        const stats = store.getStats();
        const enriched = {
          ...result,
          evidence: buildNegativeEvidence(
            stats.totalFiles,
            stats.totalSymbols,
            false,
            'get_feature_context',
          ),
        };
        return { content: [{ type: 'text', text: jh('get_feature_context', enriched) }] };
      }
      const freshened = enrichItemsWithFreshness(store, projectRoot, result.items);
      const top = freshened.items[0];
      const confidence = computeRetrievalConfidence({
        scores: freshened.items.map((i) => Number((i as { score?: number }).score ?? 0)),
        topName: (top as { name?: string }).name ?? null,
        topFqn: (top as { fqn?: string | null }).fqn ?? null,
        query: description,
        freshnessSummary: freshened.summary,
      });
      const payload: Record<string, unknown> = {
        ...result,
        items: freshened.items,
        _meta: {
          freshness: freshened.summary,
          ...(confidence
            ? { confidence: confidence.confidence, confidence_signals: confidence.signals }
            : {}),
        },
      };
      if (output_format === 'markdown') {
        const md = renderItemsMarkdown(
          (
            freshened.items as Array<{
              name?: string;
              file?: string;
              symbol_id?: string;
              source?: string;
              score?: number;
            }>
          ).map((i) => ({
            name: i.name ?? null,
            file: i.file ?? null,
            symbol_id: i.symbol_id ?? null,
            source: i.source ?? null,
            score: typeof i.score === 'number' ? i.score : null,
          })),
          { title: `Feature context: ${description}`, sectionTitle: 'Matches' },
        );
        // Drop the structured items to maximize savings — _meta + _freshness summary stay.
        const mdPayload = {
          content: md,
          format: 'markdown' as const,
          token_usage: (payload as { token_usage?: unknown }).token_usage,
          _meta: payload._meta,
        };
        return { content: [{ type: 'text', text: jh('get_feature_context', mdPayload) }] };
      }
      return { content: [{ type: 'text', text: jh('get_feature_context', payload) }] };
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

  server.tool(
    'get_related_symbols',
    'Find symbols related via co-location (same file), shared importers, and name similarity. Use when exploring a symbol to discover sibling code. For call-graph relationships use get_call_graph instead; for all usages use find_usages. Read-only. Returns JSON: { related: [{ symbol_id, name, kind, file, relation_type, score }] }.',
    {
      symbol_id: z.string().max(512).describe('Symbol ID to find related symbols for'),
      max_results: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
    },
    async ({ symbol_id, max_results }) => {
      const result = getRelatedSymbols(store, {
        symbolId: symbol_id,
        maxResults: max_results ?? 20,
      });
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: jh('get_related_symbols', result.value) }] };
    },
  );

  server.tool(
    'get_context_bundle',
    "Get a symbol's source code + its import dependencies + optional callers, packed within a token budget. Supports batch queries with shared-import deduplication. Use instead of chaining get_symbol calls — deduplicates shared imports across symbols. For a single symbol without imports, get_symbol is lighter. Read-only. Returns JSON: { primary: [{ symbol_id, file, source }], imports: [{ file, source }], token_usage }.",
    {
      symbol_id: optionalNonEmptyString(512).describe('Single symbol ID'),
      symbol_ids: z
        .array(z.string().max(512))
        .max(20)
        .optional()
        .describe('Batch: multiple symbol IDs'),
      fqn: optionalNonEmptyString(512).describe('Alternative: look up by FQN'),
      include_callers: z
        .boolean()
        .optional()
        .describe('Include who calls these symbols (default false)'),
      token_budget: z
        .number()
        .int()
        .min(100)
        .max(100000)
        .optional()
        .describe('Max tokens (default 8000)'),
      output_format: z
        .enum(['json', 'markdown'])
        .optional()
        .describe('Output format (default json)'),
    },
    async ({ symbol_id, symbol_ids, fqn, include_callers, token_budget, output_format }) => {
      const ids = symbol_ids ?? (symbol_id ? [symbol_id] : []);
      const budgetState = {
        totalCalls: savings.getSessionStats().total_calls,
        totalRawTokens: savings.getSessionStats().total_raw_tokens,
      };
      const adaptive = computeAdaptiveBudget('get_context_bundle', budgetState, token_budget);
      const result = getContextBundle(store, projectRoot, {
        symbolIds: ids,
        fqn: fqn ?? undefined,
        includeCallers: include_callers ?? false,
        tokenBudget: adaptive.budget,
        outputFormat: output_format ?? 'json',
      });
      if (result.isErr()) {
        return {
          content: [{ type: 'text', text: j(formatToolError(result.error)) }],
          isError: true,
        };
      }
      // Mark all files in the bundle as explored
      for (const sym of result.value.primary ?? []) {
        if (sym.file) markExplored(sym.file);
      }
      // Per-symbol _freshness + summary in _meta
      const primaryItems = (result.value.primary ?? []) as Array<{
        file: string;
        name?: string;
        fqn?: string | null;
      }>;
      let payload: Record<string, unknown> = { ...(result.value as Record<string, unknown>) };
      if (primaryItems.length > 0) {
        const freshened = enrichItemsWithFreshness(store, projectRoot, primaryItems);
        payload.primary = freshened.items;
        const top = freshened.items[0];
        const confidence = computeRetrievalConfidence({
          scores: freshened.items.map(() => 1),
          topName: top?.name ?? null,
          topFqn: top?.fqn ?? null,
          query: fqn ?? symbol_id ?? symbol_ids?.[0] ?? '',
          freshnessSummary: freshened.summary,
        });
        payload._meta = {
          ...((payload._meta as Record<string, unknown> | undefined) ?? {}),
          freshness: freshened.summary,
          ...(confidence
            ? { confidence: confidence.confidence, confidence_signals: confidence.signals }
            : {}),
        };
      }
      return { content: [{ type: 'text', text: jh('get_context_bundle', payload) }] };
    },
  );

  server.tool(
    'get_task_context',
    'All-in-one context for starting a dev task: execution paths, tests, entry points, adapted by task type. Use as your FIRST call when beginning any new task — replaces manual chaining of search → get_symbol → Read. For narrower feature-code lookup use get_feature_context instead. Read-only. Returns JSON (default) or Markdown.',
    {
      task: z.string().min(1).max(2000).describe('Natural language description of the task'),
      token_budget: z
        .number()
        .int()
        .min(100)
        .max(100000)
        .optional()
        .describe('Max tokens (default 8000)'),
      focus: z
        .enum(['minimal', 'broad', 'deep'])
        .optional()
        .describe(
          'Context strategy: minimal (fast, essential only), broad (default, wide net), deep (follow full execution chains)',
        ),
      include_tests: z.boolean().optional().describe('Include relevant test files (default true)'),
      output_format: z
        .enum(['json', 'markdown'])
        .optional()
        .describe(
          'Output format. "json" (default) returns structured fields; "markdown" returns a single LLM-optimized document with code fences (~15-20% token savings).',
        ),
    },
    async ({ task, token_budget, focus, include_tests, output_format }) => {
      const budgetState = {
        totalCalls: savings.getSessionStats().total_calls,
        totalRawTokens: savings.getSessionStats().total_raw_tokens,
      };
      const adaptive = computeAdaptiveBudget('get_task_context', budgetState, token_budget);
      const result = await getTaskContext(
        store,
        projectRoot,
        {
          task,
          tokenBudget: adaptive.budget,
          focus: focus ?? 'broad',
          includeTests: include_tests ?? true,
        },
        { vectorStore, embeddingService },
      );
      const output: Record<string, unknown> =
        typeof result === 'object' && result !== null
          ? { ...(result as unknown as Record<string, unknown>) }
          : { data: result };
      if (adaptive.reduced) {
        output._budget_adaptive = { budget: adaptive.budget, reason: adaptive.reason };
      }
      // Per-symbol _freshness + summary in _meta
      if (Array.isArray(output.symbols) && (output.symbols as unknown[]).length > 0) {
        const symItems = output.symbols as Array<{
          file: string;
          name?: string;
          fqn?: string | null;
        }>;
        const freshened = enrichItemsWithFreshness(store, projectRoot, symItems);
        output.symbols = freshened.items;
        const top = freshened.items[0];
        const confidence = computeRetrievalConfidence({
          scores: freshened.items.map(() => 1),
          topName: top?.name ?? null,
          topFqn: top?.fqn ?? null,
          query: task,
          freshnessSummary: freshened.summary,
        });
        output._meta = {
          ...((output._meta as Record<string, unknown> | undefined) ?? {}),
          freshness: freshened.summary,
          ...(confidence
            ? { confidence: confidence.confidence, confidence_signals: confidence.signals }
            : {}),
        };
      }
      if (output_format === 'markdown') {
        type SrcItem = { name?: string; file?: string; symbol_id?: string; source?: string };
        const toMd = (i: SrcItem) => ({
          name: i.name ?? null,
          file: i.file ?? null,
          symbol_id: i.symbol_id ?? null,
          source: i.source ?? null,
        });
        const symbols = (output.symbols as SrcItem[] | undefined) ?? [];
        const tests = (output.tests as SrcItem[] | undefined) ?? [];
        const entryPoints = (output.entryPoints as SrcItem[] | undefined) ?? [];
        const md = renderSectionsMarkdown({
          title: `Task context: ${task}`,
          subtitle:
            typeof output.taskType === 'string'
              ? `_Detected task type: ${output.taskType}_`
              : undefined,
          groups: [
            { title: 'Primary Symbols', items: symbols.map(toMd) },
            { title: 'Entry Points', items: entryPoints.map(toMd) },
            { title: 'Tests', items: tests.map(toMd) },
          ],
        });
        const mdOutput = {
          content: md,
          format: 'markdown' as const,
          taskType: output.taskType,
          token_usage: output.token_usage,
          _meta: output._meta,
          ...(output._budget_adaptive ? { _budget_adaptive: output._budget_adaptive } : {}),
        };
        return { content: [{ type: 'text', text: jh('get_task_context', mdOutput) }] };
      }
      return { content: [{ type: 'text', text: jh('get_task_context', output) }] };
    },
  );
}
