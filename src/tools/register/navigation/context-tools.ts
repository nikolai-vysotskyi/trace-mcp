import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { optionalNonEmptyString } from '../_zod-helpers.js';
import { formatToolError } from '../../../errors.js';
import { computeAdaptiveBudget } from '../../../scoring/adaptive-budget.js';
import { enrichItemsWithFreshness } from '../../../scoring/freshness.js';
import { renderItemsMarkdown } from '../../../scoring/markdown-render.js';
import { computeRetrievalConfidence } from '../../../scoring/retrieval-confidence.js';
import type { ServerContext } from '../../../server/types.js';
import { getFeatureContext } from '../../navigation/context.js';
import { getContextBundle } from '../../navigation/context-bundle.js';
import { buildNegativeEvidence } from '../../shared/evidence.js';
import { OutputFormatSchema, encodeResponse } from '../../_common/output-format.js';
import { withRecallTimeout } from '../../../utils/recall-timeout.js';

/**
 * Registers `get_context_bundle` and `get_feature_context` — multi-symbol /
 * keyword-driven context-assembly tools that pack results within a token
 * budget. `get_task_context` (the third context-assembly tool) lives in its
 * own file, task-context-tools.ts, since its task-type/markdown branching
 * alone is large enough to warrant isolation.
 */
export function registerContextTools(server: McpServer, ctx: ServerContext): void {
  const { store, projectRoot, j, jh, savings, markExplored, config } = ctx;
  const recallTimeoutMs = config?.memory?.recall?.timeoutMs ?? 5000;

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
        .describe('Output format (default json).'),
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
        outputFormat: output_format === 'markdown' ? 'markdown' : 'json',
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
      let payload: Record<string, unknown> = { ...result.value };
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
    'get_feature_context',
    'Search code by keyword/topic → returns ranked source code snippets within a token budget. Use when you need to READ actual code for a concept or feature. For structured task context with tests and entry points, use get_task_context instead. For symbol metadata without source, use search. Read-only. Returns JSON (default) or Markdown: { items: [{ symbol_id, name, file, source, score }], token_usage } | { content: "...markdown..." }. Set `output_format: "toon"` for lossless TOON encoding — cheaper LLM tokens on tabular payloads. Hard-capped by `memory.recall.timeoutMs` (default 5000 ms); on timeout returns `{ items: [], token_usage, degraded: true }` so the agent turn never blocks on slow IO.',
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
      output_format: OutputFormatSchema.describe(
        'Output format. "json" (default) returns structured items; "markdown" returns LLM-friendly fenced code blocks (~15-20% token savings, easier for the model to read); "toon" returns Token-Oriented Object Notation — 30-60% fewer tokens, lossless.',
      ),
    },
    async ({ description, token_budget, output_format }) => {
      const budgetState = {
        totalCalls: savings.getSessionStats().total_calls,
        totalRawTokens: savings.getSessionStats().total_raw_tokens,
      };
      const adaptive = computeAdaptiveBudget('get_feature_context', budgetState, token_budget);
      // Recall budget: degraded shape matches the existing empty-result branch
      // (items: [], totalTokens: 0, truncated: false) with degraded:true so
      // callers can detect timeout vs genuinely-empty results.
      const degradedFallback = {
        description,
        items: [],
        totalTokens: 0,
        truncated: false,
        degraded: true as const,
      };
      const result = await withRecallTimeout(
        () => getFeatureContext(store, projectRoot, description, adaptive.budget),
        {
          timeoutMs: recallTimeoutMs,
          toolName: 'get_feature_context',
          fallback: degradedFallback,
        },
      );
      if ('degraded' in result && result.degraded === true) {
        if (output_format === 'toon') {
          return { content: [{ type: 'text', text: encodeResponse(result, 'toon') }] };
        }
        return { content: [{ type: 'text', text: jh('get_feature_context', result) }] };
      }
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
        if (output_format === 'toon') {
          return { content: [{ type: 'text', text: encodeResponse(enriched, 'toon') }] };
        }
        return { content: [{ type: 'text', text: jh('get_feature_context', enriched) }] };
      }
      // FeatureContextItem carries the path as `filePath`; enrichItemsWithFreshness
      // keys off `file`. Provide it so per-item freshness actually resolves instead
      // of silently defaulting to 'fresh'.
      const freshened = enrichItemsWithFreshness(
        store,
        projectRoot,
        result.items.map((it) => ({ ...it, file: it.filePath })),
      );
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
      if (output_format === 'toon') {
        return { content: [{ type: 'text', text: encodeResponse(payload, 'toon') }] };
      }
      return { content: [{ type: 'text', text: jh('get_feature_context', payload) }] };
    },
  );
}
