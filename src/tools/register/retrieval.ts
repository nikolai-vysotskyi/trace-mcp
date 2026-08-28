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

export interface NormalizedItem {
  symbol_id: string;
  name: string | null;
  file: string | null;
  line: number | null;
  score: number;
  snippet?: string;
}

export type NamedSearchModeResult =
  | { ok: true; mode: string; items: NormalizedItem[]; total: number }
  | { ok: false; mode: string; available: readonly string[] };

/**
 * Shared dispatch for the named-retriever search modes (TRA-200 — used by
 * both `search_with_mode` and `search`'s `retriever` param, so the two
 * surfaces can never drift in behavior). Not a class/registry singleton —
 * cheap to construct per call, same as the original `search_with_mode`
 * handler did.
 */
export async function runNamedSearchMode(
  ctx: ServerContext,
  { query, mode, limit }: { query: string; mode: string; limit?: number },
): Promise<NamedSearchModeResult> {
  const modes = createDefaultSearchModeRegistry({
    store: ctx.store,
    embedding: ctx.embeddingService,
    vectorStore: ctx.vectorStore,
  });
  const retriever = modes.getMode(mode);
  if (!retriever) {
    return { ok: false, mode, available: modes.listModes() };
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
  return { ok: true, mode, items: normalized, total: normalized.length };
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

const SEARCH_WITH_MODE_DESCRIPTION =
  'Deprecated alias for `search` with `retriever` — use `search` instead (same mode names). Returns JSON: { mode, items, total }.';

export function registerRetrievalTools(server: McpServer, ctx: ServerContext): void {
  const { j } = ctx;

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
      const result = await runNamedSearchMode(ctx, { query, mode: mode ?? 'feeling_lucky', limit });
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: j({ error: 'unknown_mode', mode: result.mode, available: result.available }),
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: j({ mode: result.mode, items: result.items, total: result.total }),
          },
        ],
      };
    },
  );
}
