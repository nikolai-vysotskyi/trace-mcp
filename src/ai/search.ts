/**
 * Hybrid search: combines FTS5 + vector search using Reciprocal Rank Fusion (RRF).
 * Falls back to FTS5-only when AI is unavailable.
 */
import type Database from 'better-sqlite3';
import { searchFts, type FtsResult } from '../db/fts.js';
import type { VectorStore, EmbeddingService } from './interfaces.js';

export interface HybridSearchResult {
  symbolId: number;
  name: string;
  fqn: string | null;
  kind: string;
  fileId: number;
  symbolIdStr: string;
  score: number;
}

const RRF_K = 60;

/**
 * Combine FTS5 + vector search using RRF (Reciprocal Rank Fusion).
 *
 * When vectorStore/embeddingService are null, falls back to FTS5-only.
 */
export async function hybridSearch(
  db: Database.Database,
  query: string,
  vectorStore: VectorStore | null,
  embeddingService: EmbeddingService | null,
  limit: number,
): Promise<HybridSearchResult[]> {
  // 1. FTS5 search
  const ftsResults = searchFts(db, query, limit * 3);

  // Build FTS rank map: symbolId -> rank position (0-based)
  const ftsRanked = new Map<number, { rank: number; result: FtsResult }>();
  for (let i = 0; i < ftsResults.length; i++) {
    ftsRanked.set(ftsResults[i].symbolId, { rank: i, result: ftsResults[i] });
  }

  // 2. Vector search (if available)
  const vectorRanked = new Map<number, number>();

  if (vectorStore && embeddingService) {
    try {
      const queryEmbedding = await embeddingService.embed(query);
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

  // 3. RRF fusion
  const allIds = new Set([...ftsRanked.keys(), ...vectorRanked.keys()]);
  const fused: HybridSearchResult[] = [];

  for (const id of allIds) {
    let score = 0;

    const ftsEntry = ftsRanked.get(id);
    if (ftsEntry !== undefined) {
      score += 1 / (RRF_K + ftsEntry.rank);
    }

    const vecRank = vectorRanked.get(id);
    if (vecRank !== undefined) {
      score += 1 / (RRF_K + vecRank);
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
      const row = db.prepare(
        'SELECT id, name, fqn, kind, file_id, symbol_id FROM symbols WHERE id = ?',
      ).get(id) as { id: number; name: string; fqn: string | null; kind: string; file_id: number; symbol_id: string } | undefined;

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

  // 4. Sort by RRF score descending, return top limit
  fused.sort((a, b) => b.score - a.score);
  return fused.slice(0, limit);
}
