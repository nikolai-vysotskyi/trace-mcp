import path from 'node:path';
import type { Store, SymbolRow, FileRow } from '../db/store.js';
import { searchFts, type FtsResult } from '../db/fts.js';
import { readByteRange } from '../utils/source-reader.js';
import { hybridScore, getTypeBonus, computeRecency } from '../scoring/hybrid.js';
import { computePageRank } from '../scoring/pagerank.js';
import { notFound, type TraceMcpResult } from '../errors.js';
import { ok, err } from 'neverthrow';
import { hybridSearch as aiHybridSearch } from '../ai/search.js';
import type { VectorStore, EmbeddingService } from '../ai/interfaces.js';

// ─── get_symbol ─────────────────────────────────────────────

export interface GetSymbolResult {
  symbol: SymbolRow;
  file: FileRow;
  source: string;
}

export function getSymbol(
  store: Store,
  rootPath: string,
  opts: { symbolId?: string; fqn?: string },
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
  try {
    source = readByteRange(absPath, symbol.byte_start, symbol.byte_end);
  } catch {
    source = symbol.signature ?? '// source unavailable';
  }

  return ok({ symbol, file, source });
}

// ─── search ─────────────────────────────────────────────────

export interface SearchFilters {
  kind?: string;
  language?: string;
  filePattern?: string;
}

export interface SearchResultItem {
  symbol: SymbolRow;
  file: FileRow;
  score: number;
}

export interface SearchResult {
  items: SearchResultItem[];
  total: number;
}

export interface SearchAIOptions {
  vectorStore?: VectorStore | null;
  embeddingService?: EmbeddingService | null;
}

export function search(
  store: Store,
  query: string,
  filters?: SearchFilters,
  limit = 20,
  offset = 0,
  _aiOptions?: SearchAIOptions,
): SearchResult {
  // Get raw FTS results (fetch more to allow for post-filtering)
  const fetchLimit = limit + offset + 50;
  const ftsResults = searchFts(store.db, query, fetchLimit, 0);

  if (ftsResults.length === 0) {
    return { items: [], total: 0 };
  }

  // Build PageRank map (cached per search is fine for now)
  const pagerankMap = computePageRank(store.db);
  const maxPr = Math.max(...pagerankMap.values(), 0.001);

  // Normalize FTS ranks (BM25 ranks are negative, lower = better)
  const minRank = Math.min(...ftsResults.map((r) => r.rank));
  const maxRank = Math.max(...ftsResults.map((r) => r.rank));
  const rankSpread = maxRank - minRank || 1;

  const now = new Date();
  const scored: SearchResultItem[] = [];

  for (const fts of ftsResults) {
    const symbol = store.getSymbolBySymbolId(fts.symbolIdStr);
    if (!symbol) continue;

    const file = store.getFileById(symbol.file_id);
    if (!file) continue;

    // Apply filters
    if (filters?.kind && symbol.kind !== filters.kind) continue;
    if (filters?.language && file.language !== filters.language) continue;
    if (filters?.filePattern && !file.path.includes(filters.filePattern)) continue;

    // Compute hybrid score
    const relevance = 1 - (fts.rank - minRank) / rankSpread;
    const nodeId = store.getNodeId('symbol', symbol.id);
    const pr = nodeId ? (pagerankMap.get(nodeId) ?? 0) / maxPr : 0;
    const recency = computeRecency(file.indexed_at, now);
    const typeBonus = getTypeBonus(symbol.kind);

    const score = hybridScore({ relevance, pagerank: pr, recency, typeBonus });
    scored.push({ symbol, file, score });
  }

  // Sort by hybrid score descending
  scored.sort((a, b) => b.score - a.score);

  const total = scored.length;
  const items = scored.slice(offset, offset + limit);

  return { items, total };
}

// ─── get_file_outline ───────────────────────────────────────

export interface FileOutlineSymbol {
  symbolId: string;
  name: string;
  kind: string;
  fqn: string | null;
  signature: string | null;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface FileOutlineResult {
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
    symbols: symbols.map((s) => ({
      symbolId: s.symbol_id,
      name: s.name,
      kind: s.kind,
      fqn: s.fqn,
      signature: s.signature,
      lineStart: s.line_start,
      lineEnd: s.line_end,
    })),
  });
}
