import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatToolError } from '../../errors.js';
import { decisionsForImpact } from '../../memory/enrichment.js';
import { computeAdaptiveBudget } from '../../scoring/adaptive-budget.js';
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
      symbol_id: z.string().max(512).optional().describe('The symbol_id to look up'),
      fqn: z.string().max(512).optional().describe('The fully qualified name to look up'),
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
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'search',
    'Search symbols by name, kind, or text. Use instead of Grep when looking for functions, classes, methods, or variables in source code. For raw text/string/comment search use search_text instead. For finding who references a known symbol use find_usages instead. Supports kind/language/file_pattern filters. Set fuzzy=true for typo-tolerant search (trigram + Levenshtein). For natural-language / conceptual queries set semantic="on" (requires an AI provider configured + embed_repo run once). Set fusion=true for Signal Fusion — multi-channel ranking (BM25 + PageRank + embeddings + identity match) via Weighted Reciprocal Rank fusion. Read-only. Returns JSON: { items: [{ symbol_id, name, kind, fqn, signature, file, line, score }], total, search_mode }.',
    {
      query: z.string().min(1).max(500).describe('Search query'),
      kind: z
        .string()
        .max(64)
        .optional()
        .describe('Filter by symbol kind (class, method, function, etc.)'),
      language: z.string().max(64).optional().describe('Filter by language'),
      file_pattern: z.string().max(512).optional().describe('Filter by file path pattern'),
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
    }) => {
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

      const result = await search(
        store,
        query,
        { kind, language, filePattern: file_pattern, implements: impl, extends: ext, decorator },
        limit ?? 20,
        offset ?? 0,
        { vectorStore, embeddingService, reranker },
        { fuzzy, fuzzyThreshold: fuzzy_threshold, maxEditDistance: max_edit_distance },
        { semantic, semanticWeight: semantic_weight },
        fusion ? { fusion: true, weights: fusion_weights, debug: fusion_debug } : undefined,
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
      const response: Record<string, unknown> = {
        items,
        total: result.total,
        search_mode: result.search_mode,
      };
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

      return { content: [{ type: 'text', text: jh('search', response) }] };
    },
  );

  server.tool(
    'get_outline',
    "Get all symbols for a file (signatures only, no bodies). Use instead of Read to understand a file before editing — much cheaper in tokens. For reading one symbol's source, follow up with get_symbol. Read-only. Returns JSON: { path, language, symbols: [{ symbolId, name, kind, signature, lineStart, lineEnd }] }.",
    {
      path: z.string().max(512).describe('Relative file path'),
    },
    async ({ path: filePath }) => {
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
      return { content: [{ type: 'text', text: jh('get_outline', result.value) }] };
    },
  );

  server.tool(
    'get_change_impact',
    'Full change impact report: risk score + mitigations, breaking change detection, enriched dependents (complexity, coverage, exports), module groups, affected tests, co-change hidden couplings. Supports diff-aware mode via symbol_ids to scope analysis to only changed symbols. Use before modifying code to understand blast radius. For quick risk assessment without full report, use assess_change_risk instead. Read-only. Returns JSON: { risk, dependents, affectedTests, breakingChanges, totalAffected }.',
    {
      file_path: z.string().max(512).optional().describe('Relative file path to analyze'),
      symbol_id: z.string().max(512).optional().describe('Symbol ID to analyze'),
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
    'Search code by keyword/topic → returns ranked source code snippets within a token budget. Use when you need to READ actual code for a concept or feature. For structured task context with tests and entry points, use get_task_context instead. For symbol metadata without source, use search. Read-only. Returns JSON: { items: [{ symbol_id, name, file, source, score }], token_usage }.',
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
    },
    async ({ description, token_budget }) => {
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
      return { content: [{ type: 'text', text: jh('get_feature_context', result) }] };
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
      symbol_id: z.string().max(512).optional().describe('Single symbol ID'),
      symbol_ids: z
        .array(z.string().max(512))
        .max(20)
        .optional()
        .describe('Batch: multiple symbol IDs'),
      fqn: z.string().max(512).optional().describe('Alternative: look up by FQN'),
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
      return { content: [{ type: 'text', text: jh('get_context_bundle', result.value) }] };
    },
  );

  server.tool(
    'get_task_context',
    'All-in-one context for starting a dev task: execution paths, tests, entry points, adapted by task type. Use as your FIRST call when beginning any new task — replaces manual chaining of search → get_symbol → Read. For narrower feature-code lookup use get_feature_context instead. Read-only. Returns JSON: { symbols: [{ symbol_id, name, file, source }], tests, entryPoints, taskType, token_usage }.',
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
    },
    async ({ task, token_budget, focus, include_tests }) => {
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
      return { content: [{ type: 'text', text: jh('get_task_context', output) }] };
    },
  );
}
