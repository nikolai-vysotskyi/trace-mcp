/**
 * Search-tool dispatcher — internal helper shared by the `search` MCP tool
 * registration and the `SearchToolRetriever` adapter (plan P03 migration).
 *
 * Both call sites need the same dispatch logic:
 *   - `flat` mode → raw FTS hits, no PageRank/fusion (`runFlatSearch`)
 *   - `get`  mode → exact symbol_id / FQN / path lookup (`resolveExactLookup`)
 *   - else        → full `search()` path from `./navigation.ts`
 *
 * This module is intentionally a pure helper: no MCP types, no Zod, no
 * response envelope. The caller wraps the result.
 *
 * Extracted from `src/tools/register/navigation.ts` in the SearchToolRetriever
 * migration so we don't duplicate the dispatch in two places. Behaviour is
 * IDENTICAL — see `src/retrieval/__tests__/search-tool-equivalence.test.ts`.
 */
import { searchFts as ftsSearch } from '../../db/fts.js';
import type { FileRow, Store, SymbolRow } from '../../db/store.js';

/** Filters accepted by the flat-mode search path. */
export interface FlatSearchFilters {
  kind?: string;
  language?: string;
  filePattern?: string;
  implements?: string;
  extends?: string;
  decorator?: string;
}

/** Result shape for `runFlatSearch` — mirrors `SearchResult` minimally so it
 *  composes with the downstream projection layer in the tool registration. */
export interface FlatSearchResult {
  items: { symbol: SymbolRow; file: FileRow; score: number }[];
  total: number;
  search_mode: 'flat';
  /** Always undefined for flat mode — present only so the union type stays
   *  assignment-compatible with `SearchResult.fusion_debug`. */
  fusion_debug?: undefined;
}

/**
 * `flat` mode entry point: BM25 hits, no PageRank / hybrid / fusion enrichment.
 * Returns a result object shaped like `search()`'s output so the rest of the
 * tool pipeline (projection, freshness, _meta) can treat it uniformly.
 */
export async function runFlatSearch(
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

/** Shape returned by `resolveExactLookup` — null when no match. */
export interface ExactLookupResult {
  symbol_id: string;
  name: string;
  kind: string;
  fqn: string | null;
  file: string;
  line: number | null;
}

/**
 * `get` mode entry point: exact symbol_id or file path lookup. No search.
 *
 * - If the query parses as a symbol_id (contains `:` and matches the
 *   lang:path:line:col:name shape), we look it up by symbol_id first, then by FQN.
 * - If the query looks like a file path, we return the first symbol of that file
 *   as a representative.
 * - Otherwise (the heuristic flagged it as path-shaped but nothing matched),
 *   returns null.
 */
export function resolveExactLookup(store: Store, query: string): ExactLookupResult | null {
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
