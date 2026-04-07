import path from 'node:path';
import type { Store, SymbolRow, FileRow } from '../../db/store.js';
import { searchFts, type FtsResult, type FtsFilters } from '../../db/fts.js';
import { fuzzySearch, type FuzzyMatch } from '../../db/fuzzy.js';
import { readByteRange } from '../../utils/source-reader.js';
import { hybridScore, getTypeBonus, computeRecency } from '../../scoring/hybrid.js';
import { computePageRank } from '../../scoring/pagerank.js';
import { notFound, type TraceMcpResult } from '../../errors.js';
import { ok, err } from 'neverthrow';
import { hybridSearch as aiHybridSearch } from '../../ai/search.js';
import type { VectorStore, EmbeddingService, RerankerService } from '../../ai/interfaces.js';

// ─── get_symbol ─────────────────────────────────────────────

interface GetSymbolResult {
  symbol: SymbolRow;
  file: FileRow;
  source: string;
  truncated?: boolean;
}

export function getSymbol(
  store: Store,
  rootPath: string,
  opts: { symbolId?: string; fqn?: string; maxLines?: number },
): TraceMcpResult<GetSymbolResult> {
  let symbol: SymbolRow | undefined;

  if (opts.symbolId) {
    symbol = store.getSymbolBySymbolId(opts.symbolId);
  } else if (opts.fqn) {
    symbol = store.getSymbolByFqn(opts.fqn);
  }

  if (!symbol) {
    return err(notFound(opts.symbolId ?? opts.fqn ?? 'unknown'));
  }

  const file = store.getFileById(symbol.file_id);
  if (!file) {
    return err(notFound(`file:${symbol.file_id}`));
  }

  const absPath = path.resolve(rootPath, file.path);
  let source: string;
  let truncated: boolean | undefined;
  try {
    source = readByteRange(absPath, symbol.byte_start, symbol.byte_end, !!file.gitignored);
    if (opts.maxLines != null) {
      const lines = source.split('\n');
      if (lines.length > opts.maxLines) {
        source = lines.slice(0, opts.maxLines).join('\n') + '\n// ... truncated';
        truncated = true;
      }
    }
  } catch {
    source = symbol.signature ?? '// source unavailable';
  }

  return ok({ symbol, file, source, ...(truncated ? { truncated: true } : {}) });
}

// ─── search ─────────────────────────────────────────────────

interface SearchFilters {
  kind?: string;
  language?: string;
  filePattern?: string;
  /** Filter to symbols that implement this interface (metadata.implements contains value) */
  implements?: string;
  /** Filter to symbols that extend this class/interface (metadata.extends contains value) */
  extends?: string;
  /** Filter to symbols that have this decorator/annotation/attribute (checks metadata.decorators, metadata.annotations, metadata.attributes) */
  decorator?: string;
}

interface SearchResultItem {
  symbol: SymbolRow;
  file: FileRow;
  score: number;
}

/** Projected search item: only fields useful to an AI client */
export interface SearchResultItemProjected {
  symbol_id: string;
  name: string;
  kind: string;
  fqn: string | null;
  signature: string | null;
  summary: string | null;
  file: string;
  line: number | null;
  score: number;
  decorators?: string[];
}

interface SearchAIOptions {
  vectorStore?: VectorStore | null;
  embeddingService?: EmbeddingService | null;
  reranker?: RerankerService | null;
}

interface FuzzyOptions {
  fuzzy?: boolean;
  fuzzyThreshold?: number;
  maxEditDistance?: number;
}

interface SearchResult {
  items: SearchResultItem[];
  total: number;
  search_mode?: 'hybrid_ai' | 'fts' | 'fuzzy';
}

export async function search(
  store: Store,
  query: string,
  filters?: SearchFilters,
  limit = 20,
  offset = 0,
  aiOptions?: SearchAIOptions,
  fuzzyOptions?: FuzzyOptions,
): Promise<SearchResult> {
  const fetchLimit = limit + offset + 50;
  const useAI = !!(aiOptions?.vectorStore && aiOptions?.embeddingService);

  // Explicit fuzzy mode — skip FTS/AI entirely
  if (fuzzyOptions?.fuzzy) {
    return runFuzzySearch(store, query, filters, limit, offset, fuzzyOptions);
  }

  // Build initial candidates: (symbolIdStr, relevance [0,1])
  let candidates: Array<{ symbolIdStr: string; relevance: number }>;
  let searchMode: 'hybrid_ai' | 'fts';

  if (useAI) {
    const hybridResults = await aiHybridSearch(
      store.db,
      query,
      aiOptions!.vectorStore!,
      aiOptions!.embeddingService!,
      fetchLimit,
      aiOptions?.reranker,
    );
    if (hybridResults.length === 0) return { items: [], total: 0, search_mode: 'hybrid_ai' };
    // Normalize RRF scores (already positive, descending)
    const maxScore = hybridResults[0].score || 1;
    candidates = hybridResults.map((r) => ({
      symbolIdStr: r.symbolIdStr,
      relevance: r.score / maxScore,
    }));
    searchMode = 'hybrid_ai';
  } else {
    const ftsFilters: FtsFilters = {
      kind: filters?.kind,
      language: filters?.language,
      filePattern: filters?.filePattern,
    };
    const ftsResults = searchFts(store.db, query, fetchLimit, 0, ftsFilters);
    if (ftsResults.length === 0) return { items: [], total: 0, search_mode: 'fts' };
    // BM25 ranks are negative: lower = better match
    const minRank = Math.min(...ftsResults.map((r) => r.rank));
    const maxRank = Math.max(...ftsResults.map((r) => r.rank));
    const rankSpread = maxRank - minRank || 1;
    candidates = ftsResults.map((r) => ({
      symbolIdStr: r.symbolIdStr,
      relevance: 1 - (r.rank - minRank) / rankSpread,
    }));
    searchMode = 'fts';
  }

  // Build PageRank map
  const pagerankMap = computePageRank(store.db);
  const maxPr = Math.max(...pagerankMap.values(), 0.001);
  const now = new Date();
  const scored: SearchResultItem[] = [];

  // Batch-fetch all candidate symbols in one query
  const symbolIdStrs = candidates.map((c) => c.symbolIdStr);
  const allSymbols = symbolIdStrs.length > 0
    ? store.db.prepare(
        `SELECT * FROM symbols WHERE symbol_id IN (${symbolIdStrs.map(() => '?').join(',')})`,
      ).all(...symbolIdStrs) as SymbolRow[]
    : [];
  const symbolByIdStr = new Map(allSymbols.map((s) => [s.symbol_id, s]));

  // Batch-fetch files and node IDs
  const fileIds = [...new Set(allSymbols.map((s) => s.file_id))];
  const fileMap = store.getFilesByIds(fileIds);
  const symIds = allSymbols.map((s) => s.id);
  const nodeMap = store.getNodeIdsBatch('symbol', symIds);

  // Post-filters: implements / extends / decorator (check symbol metadata)
  const heritageFilter = filters?.implements || filters?.extends;
  const decoratorFilter = filters?.decorator;

  for (const candidate of candidates) {
    const symbol = symbolByIdStr.get(candidate.symbolIdStr);
    if (!symbol) continue;

    if ((heritageFilter || decoratorFilter) && symbol.metadata) {
      const meta = typeof symbol.metadata === 'string'
        ? JSON.parse(symbol.metadata) as Record<string, unknown>
        : symbol.metadata as Record<string, unknown>;

      if (filters?.implements) {
        const impl = meta['implements'];
        if (!Array.isArray(impl) || !(impl as string[]).includes(filters.implements)) continue;
      }
      if (filters?.extends) {
        const ext = meta['extends'];
        const extArr = Array.isArray(ext) ? ext as string[] : typeof ext === 'string' ? [ext] : [];
        if (!extArr.includes(filters.extends)) continue;
      }
      if (decoratorFilter) {
        // Check all decorator-like fields: decorators (TS/Python), annotations (Java), attributes (PHP)
        const decorators = (meta['decorators'] as string[] | undefined)
          ?? (meta['annotations'] as string[] | undefined)
          ?? (meta['attributes'] as string[] | undefined);
        if (!Array.isArray(decorators) || !decorators.some((d) =>
          d === decoratorFilter || d.endsWith(`.${decoratorFilter}`) || d.startsWith(`${decoratorFilter}(`),
        )) continue;
      }
    } else if (heritageFilter || decoratorFilter) {
      continue; // no metadata → can't match metadata filter
    }

    const file = fileMap.get(symbol.file_id);
    if (!file) continue;

    const nodeId = nodeMap.get(symbol.id);
    const pr = nodeId ? (pagerankMap.get(nodeId) ?? 0) / maxPr : 0;
    const recency = computeRecency(file.indexed_at, now);
    const typeBonus = getTypeBonus(symbol.kind);

    const score = hybridScore({ relevance: candidate.relevance, pagerank: pr, recency, typeBonus });
    scored.push({ symbol, file, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const total = scored.length;
  const items = scored.slice(offset, offset + limit);

  // Auto-fallback: if BM25/AI returns 0 results, try fuzzy search transparently
  if (items.length === 0 && !fuzzyOptions?.fuzzy) {
    const fuzzyResult = runFuzzySearch(store, query, filters, limit, offset, {
      fuzzyThreshold: 0.2,
      maxEditDistance: 3,
    });
    if (fuzzyResult.items.length > 0) return fuzzyResult;
  }

  return { items, total, search_mode: searchMode };
}

/**
 * Execute fuzzy search and map results to SearchResultItem format.
 * Single SQL query for candidates + batch symbol/file fetch — no N+1.
 */
function runFuzzySearch(
  store: Store,
  query: string,
  filters: SearchFilters | undefined,
  limit: number,
  offset: number,
  fuzzyOpts: FuzzyOptions,
): SearchResult {
  const matches = fuzzySearch(store.db, query, {
    threshold: fuzzyOpts.fuzzyThreshold ?? 0.3,
    maxEditDistance: fuzzyOpts.maxEditDistance ?? 3,
    limit: limit + offset + 20,
    kind: filters?.kind,
    language: filters?.language,
    filePattern: filters?.filePattern,
  });

  if (matches.length === 0) return { items: [], total: 0, search_mode: 'fuzzy' };

  // Batch-fetch symbols and files for all matches (avoid N+1)
  const symbolIds = matches.map((m) => m.symbolId);
  const symbolMap = store.getSymbolsByIds(symbolIds);
  const fileIds = [...new Set(matches.map((m) => m.fileId))];
  const fileMap = store.getFilesByIds(fileIds);

  const items: SearchResultItem[] = [];
  for (const m of matches) {
    const symbol = symbolMap.get(m.symbolId);
    const file = fileMap.get(m.fileId);
    if (!symbol || !file) continue;

    // Convert similarity to a 0-1 score: combine Jaccard + inverse edit distance
    const maxName = Math.max(query.length, m.name.length);
    const editScore = maxName > 0 ? 1 - m.editDistance / maxName : 0;
    const score = 0.6 * m.similarity + 0.4 * editScore;

    items.push({ symbol, file, score });
  }

  const total = items.length;
  const sliced = items.slice(offset, offset + limit);
  return { items: sliced, total, search_mode: 'fuzzy' };
}

// ─── get_outline ───────────────────────────────────────

interface FileOutlineSymbol {
  symbolId: string;
  name: string;
  kind: string;
  fqn: string | null;
  signature: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  decorators?: string[];
}

interface FileOutlineResult {
  path: string;
  language: string | null;
  symbols: FileOutlineSymbol[];
}

export function getFileOutline(
  store: Store,
  filePath: string,
): TraceMcpResult<FileOutlineResult> {
  const file = store.getFile(filePath);
  if (!file) {
    return err(notFound(filePath));
  }

  const symbols = store.getSymbolsByFile(file.id);

  return ok({
    path: file.path,
    language: file.language,
    symbols: symbols.map((s) => {
      const base: FileOutlineSymbol = {
        symbolId: s.symbol_id,
        name: s.name,
        kind: s.kind,
        fqn: s.fqn,
        signature: s.signature,
        lineStart: s.line_start,
        lineEnd: s.line_end,
      };
      // Surface decorators/annotations/attributes from metadata
      if (s.metadata) {
        const meta = typeof s.metadata === 'string'
          ? JSON.parse(s.metadata) as Record<string, unknown>
          : s.metadata as Record<string, unknown>;
        const decs = (meta['decorators'] as string[] | undefined)
          ?? (meta['annotations'] as string[] | undefined)
          ?? (meta['attributes'] as string[] | undefined);
        if (Array.isArray(decs) && decs.length > 0) {
          base.decorators = decs;
        }
      }
      return base;
    }),
  });
}
