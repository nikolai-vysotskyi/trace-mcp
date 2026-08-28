/**
 * Named-retriever dispatch backing `search`'s `retriever` param.
 *
 * Registers no MCP tool of its own: the `search_with_mode` tool this file
 * used to expose was retired in 2.0 once `search { retriever }` covered it
 * (TRA-240). Only the shared dispatch helper survives.
 */
import type { ServerContext } from '../../server/types.js';
import { createDefaultSearchModeRegistry } from '../../retrieval/modes/registry.js';
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
 * Shared dispatch for the named-retriever search modes (TRA-200), reached
 * through `search { retriever }`. Not a class/registry singleton — cheap to
 * construct per call.
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
