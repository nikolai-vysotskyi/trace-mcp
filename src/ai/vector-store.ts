/**
 * BLOB-based vector store using SQLite.
 * Stores embeddings as Float32Array buffers, searches via brute-force cosine similarity.
 * Fine for codebases with <10K symbols.
 */
import type Database from 'better-sqlite3';
import type { VectorStore } from './interfaces.js';

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS symbol_embeddings (
  symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
)`;

export class BlobVectorStore implements VectorStore {
  constructor(private db: Database.Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(CREATE_TABLE);
  }

  insert(id: number, vector: number[]): void {
    const buf = Buffer.from(new Float32Array(vector).buffer);
    this.db.prepare(
      'INSERT OR REPLACE INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)',
    ).run(id, buf);
  }

  search(query: number[], limit: number): { id: number; score: number }[] {
    const queryArr = new Float32Array(query);
    const queryNorm = vecNorm(queryArr);
    if (queryNorm === 0) return [];

    // Use iterate() instead of all() to avoid loading every embedding into memory at once.
    // Maintain a min-heap of top-K results so we only keep `limit` items in memory.
    const topK: { id: number; score: number }[] = [];
    let minScore = -Infinity;

    const stmt = this.db.prepare('SELECT symbol_id, embedding FROM symbol_embeddings');
    for (const row of stmt.iterate() as Iterable<{ symbol_id: number; embedding: Buffer }>) {
      const embedding = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const sim = cosineSimilarity(queryArr, embedding, queryNorm);

      if (topK.length < limit) {
        topK.push({ id: row.symbol_id, score: sim });
        if (topK.length === limit) {
          topK.sort((a, b) => a.score - b.score);
          minScore = topK[0].score;
        }
      } else if (sim > minScore) {
        topK[0] = { id: row.symbol_id, score: sim };
        topK.sort((a, b) => a.score - b.score);
        minScore = topK[0].score;
      }
    }

    topK.sort((a, b) => b.score - a.score);
    return topK;
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM symbol_embeddings WHERE symbol_id = ?').run(id);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM symbol_embeddings').get() as { cnt: number };
    return row.cnt;
  }
}

function vecNorm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i];
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(a: Float32Array, b: Float32Array, aNorm?: number): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let bSumSq = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    bSumSq += b[i] * b[i];
  }

  const normA = aNorm ?? vecNorm(a);
  const normB = Math.sqrt(bSumSq);

  if (normA === 0 || normB === 0) return 0;
  return dot / (normA * normB);
}
