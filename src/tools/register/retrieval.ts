/**
 * P03 — register the `search_with_mode` MCP tool.
 *
 * This is an ADDITIVE surface. The existing `search` tool continues to
 * work bit-for-bit unchanged. `search_with_mode` is a new dispatcher
 * that routes a query to one of the named retrievers from the
 * `SearchModeRegistry`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerContext } from '../../server/types.js';
import {
  createDefaultSearchModeRegistry,
  SEARCH_MODE_NAMES,
} from '../../retrieval/modes/registry.js';
import { runRetriever } from '../../retrieval/index.js';
import type { LexicalResult } from '../../retrieval/retrievers/lexical-retriever.js';
import type { SemanticResult } from '../../retrieval/retrievers/semantic-retriever.js';
import type { HybridResult } from '../../retrieval/retrievers/hybrid-retriever.js';
import type { SummaryResult } from '../../retrieval/retrievers/summary-retriever.js';
import type { FeelingLuckyResult } from '../../retrieval/retrievers/feeling-lucky-retriever.js';

type AnyResult = LexicalResult | SemanticResult | HybridResult | SummaryResult | FeelingLuckyResult;

interface NormalizedItem {
  symbol_id: string;
  name: string | null;
  file: string | null;
  line: number | null;
  score: number;
  snippet?: string;
}

/**
 * Map a retriever result item onto the unified output shape. We look up
 * the underlying `SymbolRow` through the store so the response is
 * self-contained regardless of which retriever produced it.
 */
function normalize(item: AnyResult, ctx: ServerContext): NormalizedItem {
  const row = ctx.store.getSymbolBySymbolId(item.id);
  const file = row ? findFilePath(ctx, row.file_id) : null;
  // Summary retriever already carries the summary; prefer it as a snippet.
  let snippet: string | undefined;
  const payload = (item as { payload?: unknown }).payload as
    | { summary?: string | null }
    | undefined;
  if (payload && typeof payload.summary === 'string' && payload.summary.length > 0) {
    snippet = payload.summary;
  } else if (row?.summary) {
    // Only show summary for `summary` mode — other modes keep snippet undefined
    // to stay cheap. Caller can re-query with `mode: "summary"` if they want it.
    snippet = undefined;
  }
  return {
    symbol_id: item.id,
    name: row?.name ?? null,
    file,
    line: row?.line_start ?? null,
    score: item.score,
    snippet,
  };
}

function findFilePath(ctx: ServerContext, fileId: number): string | null {
  const row = ctx.store.db.prepare('SELECT path FROM files WHERE id = ?').get(fileId) as
    | { path: string }
    | undefined;
  return row?.path ?? null;
}

const SEARCH_WITH_MODE_DESCRIPTION = [
  'P03 — named search-mode dispatcher.',
  '',
  'Pick a `mode` to route the query to a specific retriever:',
  '- `lexical`        BM25/FTS5 over symbol names — best when you know the symbol shape.',
  '- `semantic`       Vector-NN over embedded summaries — best for conceptual queries (requires AI provider + `embed_repo`).',
  '- `hybrid`         Reciprocal-rank fusion of lexical + semantic. Degrades to lexical when no AI provider.',
  "- `summary`        Lexical hits augmented with each symbol's stored summary text — cheap context.",
  '- `feeling_lucky`  Auto-router: symbol-shape (camelCase/PascalCase/snake_case/FQN) → lexical, everything else → hybrid.',
  '',
  'The existing `search` tool is unchanged; this is an additive surface.',
  'Returns JSON: { mode, items: [{ symbol_id, name, file, line, score, snippet? }], total }.',
].join('\n');

export function registerRetrievalTools(server: McpServer, ctx: ServerContext): void {
  const { j } = ctx;
  const modes = createDefaultSearchModeRegistry({
    store: ctx.store,
    embedding: ctx.embeddingService,
    vectorStore: ctx.vectorStore,
  });

  server.tool(
    'search_with_mode',
    SEARCH_WITH_MODE_DESCRIPTION,
    {
      query: z.string().min(1).max(500).describe('Search query'),
      mode: z
        .enum(SEARCH_MODE_NAMES)
        .optional()
        .describe('Named retriever — defaults to feeling_lucky'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default 20)'),
    },
    async ({ query, mode, limit }) => {
      const resolvedMode = mode ?? 'feeling_lucky';
      const retriever = modes.getMode(resolvedMode);
      if (!retriever) {
        return {
          content: [
            {
              type: 'text',
              text: j({
                error: 'unknown_mode',
                mode: resolvedMode,
                available: modes.listModes(),
              }),
            },
          ],
          isError: true,
        };
      }

      // The retrievers do not share a single query-input shape: most consume `text`,
      // but the graph-completion retriever reads `query`. Pass both so any retriever
      // gets the field it expects without the dispatcher needing per-mode branches.
      const items = (await runRetriever(retriever, {
        text: query,
        query,
        limit,
      } as unknown as Parameters<typeof runRetriever>[1])) as AnyResult[];
      const normalized = items.map((it) => normalize(it, ctx));

      return {
        content: [
          {
            type: 'text',
            text: j({
              mode: resolvedMode,
              items: normalized,
              total: normalized.length,
            }),
          },
        ],
      };
    },
  );
}
