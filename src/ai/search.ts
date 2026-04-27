/**
 * Hybrid search: combines FTS5 + vector search using Reciprocal Rank Fusion (RRF).
 * Falls back to FTS5-only when AI is unavailable.
 */
import type Database from 'better-sqlite3';
import { searchFts, type FtsResult } from '../db/fts.js';
import type { VectorStore, EmbeddingService, RerankerService } from './interfaces.js';

interface HybridSearchResult {
  symbolId: number;
  name: string;
  fqn: string | null;
  kind: string;
  fileId: number;
  symbolIdStr: string;
  score: number;
}

export interface HybridSearchOptions {
  /**
   * Weight of the semantic (vector) component in [0, 1].
   * - 0   → FTS5 only (lexical / BM25). Equivalent to passing a null vectorStore.
   * - 0.5 → Balanced RRF fusion (default).
   * - 1   → Vector only (pure semantic).
   * Intermediate values linearly interpolate the two RRF contributions.
   */
  semanticWeight?: number;
}

const RRF_K = 60;

/**
 * Combine FTS5 + vector search using RRF (Reciprocal Rank Fusion).
 *
 * When vectorStore/embeddingService are null, falls back to FTS5-only.
 * The relative contribution of each ranker is controlled by `options.semanticWeight`
 * (default 0.5 — balanced).
 */
export async function hybridSearch(
  db: Database.Database,
  query: string,
  vectorStore: VectorStore | null,
  embeddingService: EmbeddingService | null,
  limit: number,
  reranker?: RerankerService | null,
  options?: HybridSearchOptions,
): Promise<HybridSearchResult[]> {
  // Clamp the weight; 0.5 = balanced (the historical default RRF behavior).
  const semanticWeight = Math.min(1, Math.max(0, options?.semanticWeight ?? 0.5));
  const lexicalWeight = 1 - semanticWeight;
  // semantic_only: skip FTS entirely when weight is 1
  const skipFts = semanticWeight >= 0.999;
  // lexical_only: skip vector entirely when weight is 0
  const skipVector = semanticWeight <= 0.001;
  // 1. FTS5 search (skipped in pure-semantic mode)
  const ftsResults = skipFts ? [] : searchFts(db, query, limit * 3);

  // Build FTS rank map: symbolId -> rank position (0-based)
  const ftsRanked = new Map<number, { rank: number; result: FtsResult }>();
  for (let i = 0; i < ftsResults.length; i++) {
    ftsRanked.set(ftsResults[i].symbolId, { rank: i, result: ftsResults[i] });
  }

  // 2. Vector search (if available, and not running in pure-lexical mode)
  const vectorRanked = new Map<number, number>();

  if (!skipVector && vectorStore && embeddingService) {
    try {
      const queryEmbedding = await embeddingService.embed(query, 'query');
      if (queryEmbedding.length > 0) {
        const vectorResults = vectorStore.search(queryEmbedding, limit * 3);
        for (let i = 0; i < vectorResults.length; i++) {
          vectorRanked.set(vectorResults[i].id, i);
        }
      }
    } catch {
      // Vector search failed, continue with FTS-only
    }
  }

  // 3. Weighted RRF fusion. Each ranker contributes (weight × 1 / (k + rank)).
  // weight=0.5 for both reproduces the historical balanced fusion exactly (up to a constant).
  const allIds = new Set([...ftsRanked.keys(), ...vectorRanked.keys()]);
  const fused: HybridSearchResult[] = [];

  for (const id of allIds) {
    let score = 0;

    const ftsEntry = ftsRanked.get(id);
    if (ftsEntry !== undefined) {
      score += lexicalWeight * (1 / (RRF_K + ftsEntry.rank));
    }

    const vecRank = vectorRanked.get(id);
    if (vecRank !== undefined) {
      score += semanticWeight * (1 / (RRF_K + vecRank));
    }

    // We need name/fqn/kind/fileId — get from FTS if available, else look up
    if (ftsEntry) {
      fused.push({
        symbolId: id,
        name: ftsEntry.result.name,
        fqn: ftsEntry.result.fqn,
        kind: ftsEntry.result.kind,
        fileId: ftsEntry.result.fileId,
        symbolIdStr: ftsEntry.result.symbolIdStr,
        score,
      });
    } else {
      // Symbol only in vector results — look up from DB
      const row = db
        .prepare('SELECT id, name, fqn, kind, file_id, symbol_id FROM symbols WHERE id = ?')
        .get(id) as
        | {
            id: number;
            name: string;
            fqn: string | null;
            kind: string;
            file_id: number;
            symbol_id: string;
          }
        | undefined;

      if (row) {
        fused.push({
          symbolId: id,
          name: row.name,
          fqn: row.fqn,
          kind: row.kind,
          fileId: row.file_id,
          symbolIdStr: row.symbol_id,
          score,
        });
      }
    }
  }

  // 4. Sort by RRF score descending
  fused.sort((a, b) => b.score - a.score);

  // 5. Optional reranking
  if (reranker && fused.length > 1) {
    try {
      const candidates = fused.slice(0, limit * 2);
      const docs = candidates.map((c) => ({
        id: c.symbolId,
        text: [c.kind, c.fqn ?? c.name, c.name].join(' '),
      }));
      const reranked = await reranker.rerank(query, docs, limit);
      const _rerankedIds = new Map(reranked.map((r) => [r.id, r.score]));
      const result: HybridSearchResult[] = [];
      for (const r of reranked) {
        const original = candidates.find((c) => c.symbolId === r.id);
        if (original) {
          result.push({ ...original, score: r.score });
        }
      }
      return result;
    } catch {
      // Reranker failed, fall through to RRF-only results
    }
  }

  return fused.slice(0, limit);
}
