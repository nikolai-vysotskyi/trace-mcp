import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { computeAdaptiveBudget } from '../../../scoring/adaptive-budget.js';
import { enrichItemsWithFreshness } from '../../../scoring/freshness.js';
import { renderSectionsMarkdown } from '../../../scoring/markdown-render.js';
import { computeRetrievalConfidence } from '../../../scoring/retrieval-confidence.js';
import type { ServerContext } from '../../../server/types.js';
import { getTaskContext } from '../../navigation/task-context.js';

/**
 * Registers `get_task_context` — the all-in-one dev-task context assembler
 * (execution paths, tests, entry points). Split out from context-tools.ts
 * on its own since it alone carries enough branching (task-type detection,
 * markdown rendering, adaptive budget, freshness enrichment) to keep other
 * context-assembly tools under the per-file complexity target.
 */
export function registerTaskContextTools(server: McpServer, ctx: ServerContext): void {
  const { store, projectRoot, jh, savings, vectorStore, embeddingService } = ctx;

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
