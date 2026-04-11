import path from 'node:path';
import type { Store, SymbolRow, FileRow } from '../../db/store.js';
import { searchFts, type FtsResult, type FtsFilters } from '../../db/fts.js';
import { fuzzySearch, type FuzzyMatch } from '../../db/fuzzy.js';
import { readByteRange } from '../../utils/source-reader.js';
import { hybridScore, getTypeBonus, computeRecency, computeIdentityScore } from '../../scoring/hybrid.js';
import { computePageRank } from '../../scoring/pagerank.js';
import { buildSearchCacheKey, getCachedSearch, putCachedSearch } from '../../scoring/search-cache.js';
import {
  signalFusion, buildIdentityChannel,
  type FusionChannels, type FusionWeights, type FusionDebugInfo,
} from '../../scoring/signal-fusion.js';
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

export interface SemanticOptions {
  /**
   * Semantic search mode:
   * - 'auto' (default): use hybrid when AI is available, FTS otherwise
   * - 'on':   force hybrid (still gracefully falls back to FTS if AI not configured)
   * - 'off':  force lexical-only FTS, even when AI is available
   * - 'only': pure semantic vector search, no FTS contribution
   */
  semantic?: 'auto' | 'on' | 'off' | 'only';
  /**
   * Weight of the semantic component in [0, 1]. Only meaningful in hybrid mode.
   * - 0   → lexical only (BM25)
   * - 0.5 → balanced (default)
   * - 1   → semantic only
   */
  semanticWeight?: number;
}

interface FuzzyOptions {
  fuzzy?: boolean;
  fuzzyThreshold?: number;
  maxEditDistance?: number;
}

export interface FusionSearchOptions {
  /** Enable Signal Fusion Pipeline (WRR across lexical/structural/similarity/identity). */
  fusion?: boolean;
  /** Per-channel weights. Auto-normalized to sum to 1. */
  weights?: Partial<FusionWeights>;
  /** Return per-channel debug info in each result. */
  debug?: boolean;
}

interface SearchResult {
  items: SearchResultItem[];
  total: number;
  search_mode?: 'hybrid_ai' | 'fts' | 'fuzzy' | 'fusion';
  fusion_debug?: FusionDebugInfo[];
}

export async function search(
  store: Store,
  query: string,
  filters?: SearchFilters,
  limit = 20,
  offset = 0,
  aiOptions?: SearchAIOptions,
  fuzzyOptions?: FuzzyOptions,
  semanticOptions?: SemanticOptions,
  fusionOptions?: FusionSearchOptions,
): Promise<SearchResult> {
  // ─── Signal Fusion mode ───────────────────────────────────────
  if (fusionOptions?.fusion) {
    return runFusionSearch(store, query, filters, limit, offset, aiOptions, semanticOptions, fusionOptions);
  }

  const fetchLimit = limit + offset + 50;
  const semanticMode = semanticOptions?.semantic ?? 'auto';
  const aiAvailable = !!(aiOptions?.vectorStore && aiOptions?.embeddingService);
  // 'off' forces FTS regardless of AI availability; 'only'/'on' require AI configured.
  const useAI = semanticMode === 'off'
    ? false
    : (semanticMode === 'on' || semanticMode === 'only' || semanticMode === 'auto') && aiAvailable;
  // Effective semantic weight: 'only' pins to 1, otherwise honor explicit weight (default 0.5)
  const effectiveSemanticWeight = semanticMode === 'only'
    ? 1
    : semanticOptions?.semanticWeight ?? 0.5;

  // Explicit fuzzy mode — skip FTS/AI entirely (and skip cache: results depend on
  // fuzzy threshold/edit-distance which the cache key doesn't capture)
  if (fuzzyOptions?.fuzzy) {
    return runFuzzySearch(store, query, filters, limit, offset, fuzzyOptions);
  }

  // ─── LRU cache lookup ─────────────────────────────────────────
  // Skip cache for AI mode: hybrid_ai results depend on the embedding/reranker
  // service identity and may have non-deterministic ordering across runs.
  const cacheable = !useAI;
  let cacheKey: string | null = null;
  let symbolCount = 0;
  if (cacheable) {
    symbolCount = store.getStats().totalSymbols;
    cacheKey = buildSearchCacheKey({
      query,
      filters: filters as Record<string, unknown> | undefined,
      limit,
      offset,
      mode: 'fts',
    });
    const cached = getCachedSearch(cacheKey, symbolCount);
    if (cached) return cached;
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
      { semanticWeight: effectiveSemanticWeight },
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
    const identity = computeIdentityScore(query, symbol.name, symbol.fqn);

    const score = hybridScore({ relevance: candidate.relevance, pagerank: pr, recency, typeBonus, identity });
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

  const result: SearchResult = { items, total, search_mode: searchMode };
  if (cacheable && cacheKey) putCachedSearch(cacheKey, result, symbolCount);
  return result;
}

/**
 * Signal Fusion search: build all 4 channels in parallel and fuse with WRR.
 *
 * Channels:
 *   1. lexical  — BM25 FTS results
 *   2. structural — PageRank (graph centrality)
 *   3. similarity — embedding cosine similarity (when AI available)
 *   4. identity — exact/prefix/segment match
 */
async function runFusionSearch(
  store: Store,
  query: string,
  filters: SearchFilters | undefined,
  limit: number,
  offset: number,
  aiOptions?: SearchAIOptions,
  semanticOptions?: SemanticOptions,
  fusionOptions?: FusionSearchOptions,
): Promise<SearchResult> {
  const fetchLimit = limit + offset + 100; // fetch more candidates for better fusion
  const ftsFilters: FtsFilters = {
    kind: filters?.kind,
    language: filters?.language,
    filePattern: filters?.filePattern,
  };

  // ── Channel 1: Lexical (BM25) ──────────────────────────────
  const ftsResults = searchFts(store.db, query, fetchLimit, 0, ftsFilters);

  // ── Channel 2: Structural (PageRank) ───────────────────────
  const pagerankMap = computePageRank(store.db);

  // ── Channel 3: Similarity (embeddings) — async if available ─
  const aiAvailable = !!(aiOptions?.vectorStore && aiOptions?.embeddingService);
  const semanticMode = semanticOptions?.semantic ?? 'auto';
  const useAI = semanticMode !== 'off' && aiAvailable;

  let similarityResults: Array<{ id: number; score: number }> = [];
  if (useAI) {
    try {
      const queryEmbedding = await aiOptions!.embeddingService!.embed(query);
      if (queryEmbedding.length > 0) {
        similarityResults = aiOptions!.vectorStore!.search(queryEmbedding, fetchLimit);
      }
    } catch { /* vector search failed, continue without */ }
  }

  // Collect all candidate symbol IDs from FTS + similarity
  const candidateIdStrs = new Set<string>();
  const candidateNumIds = new Set<number>();

  for (const r of ftsResults) {
    candidateIdStrs.add(r.symbolIdStr);
    candidateNumIds.add(r.symbolId);
  }
  for (const r of similarityResults) {
    candidateNumIds.add(r.id);
  }

  // Batch-fetch all symbols
  const allSymbolIds = [...candidateNumIds];
  const allSymbols = allSymbolIds.length > 0
    ? store.db.prepare(
        `SELECT * FROM symbols WHERE id IN (${allSymbolIds.map(() => '?').join(',')})`,
      ).all(...allSymbolIds) as SymbolRow[]
    : [];
  const symbolById = new Map(allSymbols.map((s) => [s.id, s]));
  const symbolByIdStr = new Map(allSymbols.map((s) => [s.symbol_id, s]));

  // Also add symbols from similarity that weren't in FTS
  for (const s of allSymbols) {
    candidateIdStrs.add(s.symbol_id);
  }

  // Batch-fetch files and node IDs
  const fileIds = [...new Set(allSymbols.map((s) => s.file_id))];
  const fileMap = store.getFilesByIds(fileIds);
  const symIds = allSymbols.map((s) => s.id);
  const nodeMap = store.getNodeIdsBatch('symbol', symIds);

  // Apply metadata filters (implements / extends / decorator)
  const heritageFilter = filters?.implements || filters?.extends;
  const decoratorFilter = filters?.decorator;
  const passesFilter = (symbol: SymbolRow): boolean => {
    if (!heritageFilter && !decoratorFilter) return true;
    if (!symbol.metadata) return false;
    const meta = typeof symbol.metadata === 'string'
      ? JSON.parse(symbol.metadata) as Record<string, unknown>
      : symbol.metadata as Record<string, unknown>;
    if (filters?.implements) {
      const impl = meta['implements'];
      if (!Array.isArray(impl) || !(impl as string[]).includes(filters.implements)) return false;
    }
    if (filters?.extends) {
      const ext = meta['extends'];
      const extArr = Array.isArray(ext) ? ext as string[] : typeof ext === 'string' ? [ext] : [];
      if (!extArr.includes(filters.extends)) return false;
    }
    if (decoratorFilter) {
      const decorators = (meta['decorators'] as string[] | undefined)
        ?? (meta['annotations'] as string[] | undefined)
        ?? (meta['attributes'] as string[] | undefined);
      if (!Array.isArray(decorators) || !decorators.some((d) =>
        d === decoratorFilter || d.endsWith(`.${decoratorFilter}`) || d.startsWith(`${decoratorFilter}(`),
      )) return false;
    }
    return true;
  };

  // Filter symbols and build candidate list
  const validCandidates: Array<{ id: string; symbol: SymbolRow; file: FileRow; nodeId?: number }> = [];
  for (const idStr of candidateIdStrs) {
    const symbol = symbolByIdStr.get(idStr);
    if (!symbol || !passesFilter(symbol)) continue;
    const file = fileMap.get(symbol.file_id);
    if (!file) continue;
    validCandidates.push({ id: idStr, symbol, file, nodeId: nodeMap.get(symbol.id) });
  }

  if (validCandidates.length === 0) return { items: [], total: 0, search_mode: 'fusion' };

  // ── Build channel inputs ───────────────────────────────────

  // Lexical channel: FTS rank order (already sorted by BM25)
  const lexicalItems: Array<{ id: string; rawScore?: number }> = [];
  for (const r of ftsResults) {
    if (symbolByIdStr.has(r.symbolIdStr)) {
      lexicalItems.push({ id: r.symbolIdStr, rawScore: r.rank });
    }
  }

  // Structural channel: sort all valid candidates by PageRank descending
  const maxPr = Math.max(...pagerankMap.values(), 0.001);
  const structuralItems = validCandidates
    .map((c) => ({
      id: c.id,
      rawScore: c.nodeId ? (pagerankMap.get(c.nodeId) ?? 0) / maxPr : 0,
    }))
    .filter((c) => c.rawScore > 0)
    .sort((a, b) => b.rawScore - a.rawScore);

  // Similarity channel: vector search results by score
  const similarityItems: Array<{ id: string; rawScore?: number }> = [];
  if (similarityResults.length > 0) {
    for (const r of similarityResults) {
      const symbol = symbolById.get(r.id);
      if (symbol && symbolByIdStr.has(symbol.symbol_id)) {
        similarityItems.push({ id: symbol.symbol_id, rawScore: r.score });
      }
    }
  }

  // Identity channel: score each candidate by name/FQN match quality
  const identityChannel = buildIdentityChannel(
    query,
    validCandidates.map((c) => ({ id: c.id, name: c.symbol.name, fqn: c.symbol.fqn })),
  );

  // ── Fuse ────────────────────────────────────────────────────
  const channels: FusionChannels = {
    lexical: { items: lexicalItems },
    structural: { items: structuralItems },
    ...(similarityItems.length > 0 ? { similarity: { items: similarityItems } } : {}),
    identity: identityChannel,
  };

  const fusionResults = signalFusion(channels, {
    weights: fusionOptions?.weights,
    debug: fusionOptions?.debug,
  });

  // Map back to SearchResultItem
  const candidateMap = new Map(validCandidates.map((c) => [c.id, c]));
  const scored: SearchResultItem[] = [];
  const debugInfos: FusionDebugInfo[] = [];

  for (const fr of fusionResults) {
    const c = candidateMap.get(fr.id);
    if (!c) continue;
    scored.push({ symbol: c.symbol, file: c.file, score: fr.score });
    if (fr.debug) debugInfos.push(fr.debug);
  }

  const total = scored.length;
  const items = scored.slice(offset, offset + limit);

  const result: SearchResult = {
    items,
    total,
    search_mode: 'fusion',
    ...(fusionOptions?.debug && debugInfos.length > 0
      ? { fusion_debug: debugInfos.slice(offset, offset + limit) }
      : {}),
  };

  return result;
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
