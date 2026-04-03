/**
 * get_feature_context tool — finds relevant symbols for a feature description
 * using FTS5 search + graph expansion + hybrid scoring + token budget assembly.
 */
import path from 'node:path';
import type { Store, SymbolRow, FileRow } from '../db/store.js';
import { hybridScore, getTypeBonus, computeRecency } from '../scoring/hybrid.js';
import { computePageRank } from '../scoring/pagerank.js';
import { assembleContext, type ContextItem } from '../scoring/assembly.js';
import { readByteRange } from '../utils/source-reader.js';

export interface FeatureContextResult {
  description: string;
  items: FeatureContextItem[];
  totalTokens: number;
  truncated: boolean;
}

export interface FeatureContextItem {
  symbolId: string;
  name: string;
  kind: string;
  fqn: string | null;
  filePath: string;
  score: number;
  detail: 'full' | 'no_source' | 'signature_only';
  content: string;
  tokens: number;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'and', 'or', 'but', 'not', 'no', 'nor', 'so', 'yet', 'both', 'either',
  'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other',
  'some', 'such', 'than', 'too', 'very', 'just', 'about', 'above', 'after',
  'before', 'between', 'under', 'over', 'out', 'up', 'down', 'off', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'what', 'which',
  'who', 'whom', 'this', 'that', 'these', 'those', 'it', 'its',
]);

/**
 * Tokenize a feature description into search terms.
 * Splits by spaces, camelCase, and snake_case, then removes stopwords.
 */
export function tokenizeDescription(description: string): string[] {
  const raw = description
    // Split camelCase
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Split snake_case
    .replace(/_/g, ' ')
    // Remove non-alphanumeric
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  // Remove stopwords and very short tokens
  return [...new Set(raw.filter((t) => t.length > 1 && !STOPWORDS.has(t)))];
}

export function getFeatureContext(
  store: Store,
  rootPath: string,
  description: string,
  tokenBudget = 4000,
): FeatureContextResult {
  const tokens = tokenizeDescription(description);

  if (tokens.length === 0) {
    return { description, items: [], totalTokens: 0, truncated: false };
  }

  // Build FTS5 query: each token as a quoted term joined by OR
  const ftsQuery = tokens.map((t) => `"${t}"`).join(' OR ');

  // Single query: join symbols + files to avoid N+1 lookups in the scoring loop
  interface FtsFullRow {
    symbolId: number;
    symbolIdStr: string;
    rank: number;
    name: string;
    fqn: string | null;
    kind: string;
    byteStart: number;
    byteEnd: number;
    signature: string | null;
    fileId: number;
    filePath: string;
    indexedAt: string;
  }

  const ftsResults = store.db.prepare(`
    SELECT
      s.id        AS symbolId,
      s.symbol_id AS symbolIdStr,
      rank        AS rank,
      s.name,
      s.fqn,
      s.kind,
      s.byte_start  AS byteStart,
      s.byte_end    AS byteEnd,
      s.signature,
      f.id        AS fileId,
      f.path      AS filePath,
      f.indexed_at  AS indexedAt
    FROM symbols_fts fts
    JOIN symbols s ON s.id = fts.rowid
    JOIN files   f ON f.id = s.file_id
    WHERE symbols_fts MATCH ?
    ORDER BY rank
    LIMIT 100
  `).all(ftsQuery) as FtsFullRow[];

  if (ftsResults.length === 0) {
    return { description, items: [], totalTokens: 0, truncated: false };
  }

  // Build PageRank map
  const pagerankMap = computePageRank(store.db);
  const maxPr = Math.max(...pagerankMap.values(), 0.001);

  // Normalize FTS ranks
  const minRank = Math.min(...ftsResults.map((r) => r.rank));
  const maxRank = Math.max(...ftsResults.map((r) => r.rank));
  const rankSpread = maxRank - minRank || 1;

  const now = new Date();

  // Score FTS results — no extra DB lookups needed, all data from the JOIN above
  type ScoredSymbol = { symbol: SymbolRow; file: FileRow; score: number };
  const scored: ScoredSymbol[] = [];
  const scoredById = new Map<string, ScoredSymbol>(); // symbolIdStr → entry for O(1) lookup later
  const seenIds = new Set<number>();

  for (const fts of ftsResults) {
    seenIds.add(fts.symbolId);

    const relevance = 1 - (fts.rank - minRank) / rankSpread;
    const nodeId = store.getNodeId('symbol', fts.symbolId);
    const pr = nodeId ? (pagerankMap.get(nodeId) ?? 0) / maxPr : 0;
    const recency = computeRecency(fts.indexedAt, now);
    const typeBonus = getTypeBonus(fts.kind);

    const score = hybridScore({ relevance, pagerank: pr, recency, typeBonus });

    // Reconstruct minimal SymbolRow / FileRow shapes needed downstream
    const symbol = {
      id: fts.symbolId,
      symbol_id: fts.symbolIdStr,
      name: fts.name,
      kind: fts.kind,
      fqn: fts.fqn,
      byte_start: fts.byteStart,
      byte_end: fts.byteEnd,
      signature: fts.signature,
      file_id: fts.fileId,
    } as SymbolRow;

    const file = {
      id: fts.fileId,
      path: fts.filePath,
      indexed_at: fts.indexedAt,
    } as FileRow;

    const entry: ScoredSymbol = { symbol, file, score };
    scored.push(entry);
    scoredById.set(fts.symbolIdStr, entry);
  }

  // Graph expansion: follow edges 1-2 hops for top results
  const topResults = scored.slice(0, 10);
  for (const item of topResults) {
    const nodeId = store.getNodeId('symbol', item.symbol.id);
    if (!nodeId) continue;

    const outEdges = store.getOutgoingEdges(nodeId);
    const inEdges = store.getIncomingEdges(nodeId);

    for (const edge of [...outEdges, ...inEdges]) {
      const otherNodeId = edge.source_node_id === nodeId
        ? edge.target_node_id
        : edge.source_node_id;

      const nodeRef = store.getNodeByNodeId(otherNodeId);
      if (!nodeRef || nodeRef.node_type !== 'symbol') continue;

      const sym = store.getSymbolById(nodeRef.ref_id);
      if (!sym || seenIds.has(sym.id)) continue;
      seenIds.add(sym.id);

      const file = store.getFileById(sym.file_id);
      if (!file) continue;

      const pr = (pagerankMap.get(otherNodeId) ?? 0) / maxPr;
      const recency = computeRecency(file.indexed_at, now);
      const typeBonus = getTypeBonus(sym.kind);

      // Graph-expanded items get a reduced relevance score
      const score = hybridScore({ relevance: 0.3, pagerank: pr, recency, typeBonus });
      const entry: ScoredSymbol = { symbol: sym, file, score };
      scored.push(entry);
      scoredById.set(sym.symbol_id, entry);
    }
  }

  // Sort by score
  scored.sort((a, b) => b.score - a.score);

  // Build context items for assembly
  const contextItems: ContextItem[] = scored.map((item) => {
    const meta = `[${item.symbol.kind}] ${item.symbol.fqn ?? item.symbol.name} (${item.file.path})`;

    let source: string | undefined;
    try {
      const absPath = path.resolve(rootPath, item.file.path);
      source = readByteRange(absPath, item.symbol.byte_start, item.symbol.byte_end);
    } catch { /* source unavailable */ }

    return {
      id: item.symbol.symbol_id,
      score: item.score,
      source,
      signature: item.symbol.signature ?? undefined,
      metadata: meta,
    };
  });

  // Assemble within token budget
  const assembled = assembleContext(contextItems, tokenBudget);

  // Build result items
  const items: FeatureContextItem[] = assembled.items.map((ai) => {
    const sym = scoredById.get(ai.id)!;
    return {
      symbolId: ai.id,
      name: sym.symbol.name,
      kind: sym.symbol.kind,
      fqn: sym.symbol.fqn,
      filePath: sym.file.path,
      score: ai.score,
      detail: ai.detail,
      content: ai.content,
      tokens: ai.tokens,
    };
  });

  return {
    description,
    items,
    totalTokens: assembled.totalTokens,
    truncated: assembled.truncated,
  };
}
