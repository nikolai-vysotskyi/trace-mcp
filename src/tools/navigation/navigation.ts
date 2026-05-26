import { readFileSync } from 'node:fs';
import path from 'node:path';
import { err, ok } from 'neverthrow';
import type { EmbeddingService, RerankerService, VectorStore } from '../../ai/interfaces.js';
import { hybridSearch as aiHybridSearch } from '../../ai/search.js';
import { type FtsFilters, searchFts } from '../../db/fts.js';
import { fuzzySearch } from '../../db/fuzzy.js';
import type { FileRow, Store, SymbolRow } from '../../db/store.js';
import { notFound, type TraceMcpResult } from '../../errors.js';
import { getParser, type TSNode } from '../../parser/tree-sitter.js';
import {
  computeIdentityScore,
  computeRecency,
  getTypeBonus,
  hybridScore,
} from '../../scoring/hybrid.js';
import { computePageRank } from '../../scoring/pagerank.js';
import {
  buildSearchCacheKey,
  getCachedSearch,
  putCachedSearch,
} from '../../scoring/search-cache.js';
import {
  buildIdentityChannel,
  type FusionChannels,
  type FusionDebugInfo,
  type FusionWeights,
  signalFusion,
} from '../../scoring/signal-fusion.js';
import { readSymbolSource } from '../../utils/source-reader.js';

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
    source = readSymbolSource(absPath, symbol.byte_start, symbol.byte_end, !!file.gitignored);
    if (opts.maxLines != null) {
      const lines = source.split('\n');
      if (lines.length > opts.maxLines) {
        source = `${lines.slice(0, opts.maxLines).join('\n')}\n// ... truncated`;
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

/** Per-fusion-call honesty signal: did the semantic channel actually fire? */
export interface FusionMeta {
  semantic_channel: 'active' | 'skipped';
  /** Reason when skipped (e.g. "no embeddings — run embed_repo first"). */
  reason?: string;
  /** Active per-channel weights after auto-normalization. */
  weights?: Partial<FusionWeights>;
  /** Per-channel candidate counts that fed into WRR. */
  contributions?: {
    lexical: number;
    structural: number;
    similarity: number;
    identity: number;
  };
}

/** Closest near-miss surfaced when fuzzy search returns zero items. */
export interface NearMiss {
  name: string;
  file: string;
  symbol_id: string;
  distance: number;
  similarity: number;
}

interface SearchResult {
  items: SearchResultItem[];
  total: number;
  search_mode?: 'hybrid_ai' | 'fts' | 'fuzzy' | 'fusion';
  fusion_debug?: FusionDebugInfo[];
  /** Set when an explicit semantic mode (`on`/`only`) was downgraded to
   *  lexical because the AI provider is not configured. Lets callers
   *  detect silent degradation instead of trusting that they got what
   *  they asked for. */
  _warning?: string;
  /** Structured error envelope for hard failures (e.g. `semantic="only"`
   *  with no AI provider). Mirrors `_warning` but signals "no usable
   *  results possible" rather than "results may be lower quality". */
  _error?: { code: string; message: string; hint?: string };
  /** Honesty signal for fusion-mode calls — was the semantic channel actually
   *  available, and how did the other channels contribute? Only set when
   *  fusion mode is requested. */
  _meta?: { fusion?: FusionMeta } & Record<string, unknown>;
  /** Closest name-similar candidates surfaced when fuzzy returns zero items.
   *  Helps the caller recover from typos by suggesting concrete next queries. */
  _near_misses?: NearMiss[];
}

/**
 * Count populated embeddings without depending on the VectorStore interface
 * (the BlobVectorStore has `count()`, others may not). We only need a
 * "does this exist?" check, so a defensive try/catch is fine.
 */
function countEmbeddings(store: Store): number {
  try {
    const row = store.db.prepare('SELECT COUNT(*) AS cnt FROM symbol_embeddings').get() as
      | { cnt: number }
      | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/** Minimum populated embeddings for the similarity channel to be considered "live". */
const MIN_EMBEDDINGS_FOR_SEMANTIC = 10;

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
    return runFusionSearch(
      store,
      query,
      filters,
      limit,
      offset,
      aiOptions,
      semanticOptions,
      fusionOptions,
    );
  }

  const fetchLimit = limit + offset + 50;
  const semanticMode = semanticOptions?.semantic ?? 'auto';
  const aiAvailable = !!(aiOptions?.vectorStore && aiOptions?.embeddingService);

  // Hard failure: `only` means "pure vector" — there is no useful FTS
  // fallback that satisfies the user's intent. Surface a structured error
  // instead of silently switching to lexical (which is what shipped before
  // and led to wrong-result surprise).
  if (semanticMode === 'only' && !aiAvailable) {
    return {
      items: [],
      total: 0,
      search_mode: 'fts',
      _error: {
        code: 'no_ai_provider',
        message:
          'semantic="only" requires an AI provider with a built embedding index, but none is configured.',
        hint: 'Configure an AI provider (e.g. ollama / openai), run `embed_repo`, then retry — or pass semantic="off" / "auto" to use lexical search.',
      },
    };
  }

  // Soft degradation: `on` was an explicit ask for hybrid; if AI isn't
  // there we fall through to FTS but stamp `_warning` on the response so
  // the caller can tell they got lower-fidelity results.
  let degradedFromOn = false;
  if (semanticMode === 'on' && !aiAvailable) {
    degradedFromOn = true;
  }

  // 'off' forces FTS regardless of AI availability; 'only'/'on' require AI configured.
  const useAI =
    semanticMode === 'off'
      ? false
      : (semanticMode === 'on' || semanticMode === 'only' || semanticMode === 'auto') &&
        aiAvailable;
  // Effective semantic weight: 'only' pins to 1, otherwise honor explicit weight (default 0.5)
  const effectiveSemanticWeight =
    semanticMode === 'only' ? 1 : (semanticOptions?.semanticWeight ?? 0.5);

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
    if (cached) {
      // `_warning` is metadata about THIS call, not the cached result body
      // — re-stamp it so a cache hit doesn't hide the silent-degradation
      // signal from the caller. Cache stays useful (same items + total)
      // while still telling the caller they didn't get hybrid ranking.
      if (degradedFromOn && !cached._warning) {
        return {
          ...cached,
          _warning:
            'semantic="on" was requested but no AI provider is available; results came from lexical (FTS5) search. Configure an AI provider + run `embed_repo` for hybrid ranking.',
        };
      }
      return cached;
    }
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
      // Exclude markdown headings/tags from default code-symbol searches.
      // Bypassed inside searchFts when the caller explicitly asked for a
      // markdown kind / language / file_pattern.
      excludeMarkdown: true,
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
  const allSymbols =
    symbolIdStrs.length > 0
      ? (store.db
          .prepare(
            `SELECT * FROM symbols WHERE symbol_id IN (${symbolIdStrs.map(() => '?').join(',')})`,
          )
          .all(...symbolIdStrs) as SymbolRow[])
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
      const meta =
        typeof symbol.metadata === 'string'
          ? (JSON.parse(symbol.metadata) as Record<string, unknown>)
          : (symbol.metadata as Record<string, unknown>);

      if (filters?.implements) {
        const impl = meta.implements;
        if (!Array.isArray(impl) || !(impl as string[]).includes(filters.implements)) continue;
      }
      if (filters?.extends) {
        const ext = meta.extends;
        const extArr = Array.isArray(ext)
          ? (ext as string[])
          : typeof ext === 'string'
            ? [ext]
            : [];
        if (!extArr.includes(filters.extends)) continue;
      }
      if (decoratorFilter) {
        // Check all decorator-like fields: decorators (TS/Python), annotations (Java), attributes (PHP)
        const decorators =
          (meta.decorators as string[] | undefined) ??
          (meta.annotations as string[] | undefined) ??
          (meta.attributes as string[] | undefined);
        if (
          !Array.isArray(decorators) ||
          !decorators.some(
            (d) =>
              d === decoratorFilter ||
              d.endsWith(`.${decoratorFilter}`) ||
              d.startsWith(`${decoratorFilter}(`),
          )
        )
          continue;
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

    const score = hybridScore({
      relevance: candidate.relevance,
      pagerank: pr,
      recency,
      typeBonus,
      identity,
    });
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
  if (degradedFromOn) {
    result._warning =
      'semantic="on" was requested but no AI provider is available; results came from lexical (FTS5) search. Configure an AI provider + run `embed_repo` for hybrid ranking.';
  }
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
    // Same default-exclusion as the single-channel `search()` path — keeps
    // markdown headings/tags from polluting the lexical channel of fusion.
    excludeMarkdown: true,
  };

  // ── Channel 1: Lexical (BM25) ──────────────────────────────
  const ftsResults = searchFts(store.db, query, fetchLimit, 0, ftsFilters);

  // ── Channel 2: Structural (PageRank) ───────────────────────
  const pagerankMap = computePageRank(store.db);

  // ── Channel 3: Similarity (embeddings) — async if available ─
  const aiAvailable = !!(aiOptions?.vectorStore && aiOptions?.embeddingService);
  const semanticMode = semanticOptions?.semantic ?? 'auto';
  // Embeddings must actually be populated for the similarity channel to be
  // useful. AI being "configured" is not the same as "embeddings exist" —
  // shipping fusion when the vector store is empty is the silent no-op we
  // are fixing here.
  const embeddingsPopulated = countEmbeddings(store);
  const hasEnoughEmbeddings = embeddingsPopulated >= MIN_EMBEDDINGS_FOR_SEMANTIC;
  const useAI = semanticMode !== 'off' && aiAvailable && hasEnoughEmbeddings;

  let similarityResults: Array<{ id: number; score: number }> = [];
  let semanticSkipReason: string | undefined;
  if (semanticMode === 'off') {
    semanticSkipReason = 'semantic="off" — caller disabled the similarity channel';
  } else if (!aiAvailable) {
    semanticSkipReason =
      'no AI provider — configure ollama/openai and run `embed_repo` to enable the similarity channel';
  } else if (!hasEnoughEmbeddings) {
    semanticSkipReason =
      embeddingsPopulated === 0
        ? 'no embeddings — run `embed_repo` first to enable the similarity channel'
        : `only ${embeddingsPopulated} symbols embedded (need >=${MIN_EMBEDDINGS_FOR_SEMANTIC}) — run \`embed_repo\` to widen coverage`;
  }

  if (useAI) {
    try {
      const queryEmbedding = await aiOptions!.embeddingService!.embed(query, 'query');
      if (queryEmbedding.length > 0) {
        similarityResults = aiOptions!.vectorStore!.search(queryEmbedding, fetchLimit);
      } else {
        semanticSkipReason = 'embedding service returned an empty vector for this query';
      }
    } catch (e) {
      semanticSkipReason = `vector search failed: ${e instanceof Error ? e.message : 'unknown error'}`;
    }
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
  const allSymbols =
    allSymbolIds.length > 0
      ? (store.db
          .prepare(`SELECT * FROM symbols WHERE id IN (${allSymbolIds.map(() => '?').join(',')})`)
          .all(...allSymbolIds) as SymbolRow[])
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
    const meta =
      typeof symbol.metadata === 'string'
        ? (JSON.parse(symbol.metadata) as Record<string, unknown>)
        : (symbol.metadata as Record<string, unknown>);
    if (filters?.implements) {
      const impl = meta.implements;
      if (!Array.isArray(impl) || !(impl as string[]).includes(filters.implements)) return false;
    }
    if (filters?.extends) {
      const ext = meta.extends;
      const extArr = Array.isArray(ext) ? (ext as string[]) : typeof ext === 'string' ? [ext] : [];
      if (!extArr.includes(filters.extends)) return false;
    }
    if (decoratorFilter) {
      const decorators =
        (meta.decorators as string[] | undefined) ??
        (meta.annotations as string[] | undefined) ??
        (meta.attributes as string[] | undefined);
      if (
        !Array.isArray(decorators) ||
        !decorators.some(
          (d) =>
            d === decoratorFilter ||
            d.endsWith(`.${decoratorFilter}`) ||
            d.startsWith(`${decoratorFilter}(`),
        )
      )
        return false;
    }
    return true;
  };

  // Filter symbols and build candidate list
  const validCandidates: Array<{ id: string; symbol: SymbolRow; file: FileRow; nodeId?: number }> =
    [];
  for (const idStr of candidateIdStrs) {
    const symbol = symbolByIdStr.get(idStr);
    if (!symbol || !passesFilter(symbol)) continue;
    const file = fileMap.get(symbol.file_id);
    if (!file) continue;
    validCandidates.push({ id: idStr, symbol, file, nodeId: nodeMap.get(symbol.id) });
  }

  // Build the _meta.fusion honesty payload early so we can return it from
  // any of the early-exit paths below.
  const buildFusionMeta = (overrideContributions?: {
    lexical: number;
    structural: number;
    similarity: number;
    identity: number;
  }): FusionMeta => {
    const meta: FusionMeta = {
      semantic_channel: similarityResults.length > 0 ? 'active' : 'skipped',
    };
    if (meta.semantic_channel === 'skipped' && semanticSkipReason) {
      meta.reason = semanticSkipReason;
    }
    if (fusionOptions?.weights) meta.weights = { ...fusionOptions.weights };
    if (overrideContributions) meta.contributions = overrideContributions;
    return meta;
  };

  if (validCandidates.length === 0) {
    return {
      items: [],
      total: 0,
      search_mode: 'fusion',
      _meta: {
        fusion: buildFusionMeta({
          lexical: 0,
          structural: 0,
          similarity: similarityResults.length,
          identity: 0,
        }),
      },
    };
  }

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
    _meta: {
      fusion: buildFusionMeta({
        lexical: lexicalItems.length,
        structural: structuralItems.length,
        similarity: similarityItems.length,
        identity: identityChannel.items.length,
      }),
    },
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

  if (matches.length === 0) {
    // Wider scan: when the strict fuzzy run finds nothing, drop the threshold
    // and the edit-distance ceiling and surface the top-5 closest names so
    // the caller has something concrete to retry with instead of a dead end.
    const nearMisses = findNearMisses(store, query, filters);
    return {
      items: [],
      total: 0,
      search_mode: 'fuzzy',
      ...(nearMisses.length > 0 ? { _near_misses: nearMisses } : {}),
    };
  }

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

/**
 * Wider trigram + Levenshtein scan used when strict fuzzy search returns 0
 * items. Lowers the threshold (trigram similarity >= 0.25) and the
 * edit-distance ceiling (<= 4) and surfaces the top-N closest names. The
 * candidate pool is already capped at 200 by the underlying SQL — replaces
 * the previous misleading "do not retry with similar terms" dead-end with
 * something concrete to re-query against.
 */
function findNearMisses(
  store: Store,
  query: string,
  filters: SearchFilters | undefined,
  limit = 5,
): NearMiss[] {
  const wider = fuzzySearch(store.db, query, {
    threshold: 0.25,
    maxEditDistance: 4,
    limit: 50,
    kind: filters?.kind,
    language: filters?.language,
    filePattern: filters?.filePattern,
  });

  if (wider.length === 0) return [];

  const ranked = wider
    .map((m) => {
      const maxName = Math.max(query.length, m.name.length);
      const editScore = maxName > 0 ? 1 - m.editDistance / maxName : 0;
      const combined = 0.6 * m.similarity + 0.4 * editScore;
      return { match: m, combined };
    })
    .sort((a, b) => b.combined - a.combined)
    .slice(0, limit);

  const fileIds = [...new Set(ranked.map((r) => r.match.fileId))];
  const fileMap = store.getFilesByIds(fileIds);

  const out: NearMiss[] = [];
  for (const { match } of ranked) {
    const file = fileMap.get(match.fileId);
    if (!file) continue;
    out.push({
      name: match.name,
      file: file.path,
      symbol_id: match.symbolIdStr,
      distance: match.editDistance,
      similarity: Number(match.similarity.toFixed(4)),
    });
  }
  return out;
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
  /** Synthetic-nesting fields. Only present on rows emitted by the nested-walk path. */
  parentId?: string;
  depth?: number;
}

interface FileOutlineResult {
  path: string;
  language: string | null;
  symbols: FileOutlineSymbol[];
}

export interface GetFileOutlineOptions {
  /** When true, walk the body of large top-level symbols and emit nested function-like declarations. */
  nested?: boolean;
  /** Minimum (line_end - line_start) for a parent symbol to be expanded. Default 100. */
  minLocForNesting?: number;
  /** Project root for filesystem reads when `nested=true`. Required for nesting. */
  projectRoot?: string;
}

/** Hard cap on nesting depth so deeply nested callbacks don't explode the response. */
const MAX_NESTING_DEPTH = 3;

const TS_FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'function',
  'function_expression',
  'arrow_function',
  'method_definition',
  'generator_function',
  'generator_function_declaration',
]);

const PY_FUNCTION_NODE_TYPES = new Set(['function_definition', 'lambda']);

const GO_FUNCTION_NODE_TYPES = new Set([
  'function_declaration',
  'method_declaration',
  'func_literal',
]);

function functionNodeTypesFor(language: string | null): Set<string> | null {
  if (!language) return null;
  if (language === 'typescript' || language === 'javascript' || language === 'tsx') {
    return TS_FUNCTION_NODE_TYPES;
  }
  if (language === 'python') return PY_FUNCTION_NODE_TYPES;
  if (language === 'go') return GO_FUNCTION_NODE_TYPES;
  return null;
}

function resolveGrammarForOutline(language: string, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsx' || ext === '.jsx') return 'tsx';
  return language;
}

function bestEffortName(node: TSNode): string {
  // function_declaration / method_definition / named function expression → name child
  const nameChild = node.childForFieldName?.('name');
  if (nameChild) return nameChild.text;

  // Arrow/function expression assigned to a binding: walk up one level.
  const parent = node.parent;
  if (parent) {
    if (parent.type === 'variable_declarator' || parent.type === 'assignment_expression') {
      const left = parent.childForFieldName?.('name') ?? parent.childForFieldName?.('left');
      if (left) return left.text;
    }
    if (parent.type === 'pair' || parent.type === 'property_definition') {
      const key = parent.childForFieldName?.('key') ?? parent.childForFieldName?.('name');
      if (key) return key.text;
    }
  }
  return '<anonymous>';
}

function kindForNode(node: TSNode): string {
  switch (node.type) {
    case 'method_definition':
    case 'method_declaration':
      return 'method';
    case 'arrow_function':
      return 'arrow_function';
    case 'function_expression':
    case 'function':
    case 'func_literal':
      return 'function_expression';
    case 'function_declaration':
    case 'function_definition':
    case 'generator_function':
    case 'generator_function_declaration':
      return 'function';
    case 'lambda':
      return 'lambda';
    default:
      return 'function';
  }
}

interface NestedCandidate {
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  depth: number;
}

/**
 * Walk descendants of `root` and collect function-like nodes. Depth grows
 * every time we cross into a function-like node, so a function nested inside
 * a function inside the parent has depth = 2. The node identical to the
 * parent symbol itself is skipped — we recurse through it without emitting.
 */
function collectNested(
  root: TSNode,
  funcTypes: Set<string>,
  parentLineStart: number,
  parentLineEnd: number,
  maxDepth: number,
): NestedCandidate[] {
  const found: NestedCandidate[] = [];

  function walk(node: TSNode, depth: number): void {
    if (depth >= maxDepth) return;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (funcTypes.has(child.type)) {
        const lineStart = child.startPosition.row + 1;
        const lineEnd = child.endPosition.row + 1;
        // Skip the node identical to the parent symbol itself.
        if (lineStart === parentLineStart && lineEnd === parentLineEnd) {
          walk(child, depth);
          continue;
        }
        const childDepth = depth + 1;
        if (childDepth <= maxDepth) {
          found.push({
            name: bestEffortName(child),
            kind: kindForNode(child),
            lineStart,
            lineEnd,
            depth: childDepth,
          });
          walk(child, childDepth);
        }
      } else {
        walk(child, depth);
      }
    }
  }

  walk(root, 0);
  return found;
}

/**
 * For one parent symbol, parse the file and extract nested function-like
 * declarations within the parent's line range. Returns empty when the grammar
 * is unsupported, the file is unreadable, or there is no nesting.
 */
async function extractNestedFunctions(
  projectRoot: string,
  filePath: string,
  language: string,
  parent: SymbolRow,
  maxDepth: number,
): Promise<NestedCandidate[]> {
  const funcTypes = functionNodeTypesFor(language);
  if (!funcTypes) return [];
  if (parent.line_start == null || parent.line_end == null) return [];

  let content: string;
  try {
    const buf = readFileSync(path.resolve(projectRoot, filePath));
    if (buf.length > 1024 * 1024) return [];
    content = buf.toString('utf-8');
  } catch {
    return [];
  }

  let tree;
  try {
    const grammar = resolveGrammarForOutline(language, filePath);
    const parser = await getParser(grammar);
    tree = parser.parse(content);
  } catch {
    return [];
  }

  const root = tree.rootNode;
  // Smallest node spanning the parent's line range.
  const parentNode = root.descendantForPosition(
    { row: parent.line_start - 1, column: 0 },
    { row: parent.line_end - 1, column: Number.MAX_SAFE_INTEGER },
  );
  if (!parentNode) return [];

  return collectNested(parentNode, funcTypes, parent.line_start, parent.line_end, maxDepth);
}

export async function getFileOutline(
  store: Store,
  filePath: string,
  opts: GetFileOutlineOptions = {},
): Promise<TraceMcpResult<FileOutlineResult>> {
  const file = store.getFile(filePath);
  if (!file) {
    return err(notFound(filePath));
  }

  const symbols = store.getSymbolsByFile(file.id);
  const projected: FileOutlineSymbol[] = [];

  const nestingEnabled = opts.nested === true && !!opts.projectRoot && !!file.language;
  const minLoc = opts.minLocForNesting ?? 100;

  for (const s of symbols) {
    const base: FileOutlineSymbol = {
      symbolId: s.symbol_id,
      name: s.name,
      kind: s.kind,
      fqn: s.fqn,
      signature: s.signature,
      lineStart: s.line_start,
      lineEnd: s.line_end,
    };
    if (s.metadata) {
      const meta =
        typeof s.metadata === 'string'
          ? (JSON.parse(s.metadata) as Record<string, unknown>)
          : (s.metadata as Record<string, unknown>);
      const decs =
        (meta.decorators as string[] | undefined) ??
        (meta.annotations as string[] | undefined) ??
        (meta.attributes as string[] | undefined);
      if (Array.isArray(decs) && decs.length > 0) {
        base.decorators = decs;
      }
    }
    projected.push(base);

    if (
      nestingEnabled &&
      s.line_start != null &&
      s.line_end != null &&
      s.line_end - s.line_start >= minLoc
    ) {
      const lang = file.language as string;
      const nested = await extractNestedFunctions(
        opts.projectRoot as string,
        file.path,
        lang,
        s,
        MAX_NESTING_DEPTH,
      );
      for (const n of nested) {
        projected.push({
          symbolId: `${s.symbol_id}::nested@${n.lineStart}`,
          name: n.name,
          kind: n.kind,
          fqn: null,
          signature: null,
          lineStart: n.lineStart,
          lineEnd: n.lineEnd,
          parentId: s.symbol_id,
          depth: n.depth,
        });
      }
    }
  }

  return ok({
    path: file.path,
    language: file.language,
    symbols: projected,
  });
}
