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
);
CREATE TABLE IF NOT EXISTS embedding_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`;

export class DimensionMismatchError extends Error {
  constructor(expected: number, got: number) {
    super(
      `Vector dimension mismatch: expected ${expected}, got ${got}. Run embed_repo with force=true to re-embed.`,
    );
    this.name = 'DimensionMismatchError';
  }
}

/**
 * Raised when the configured embedding provider/model does not match the
 * one that built the index on disk. Querying a vector store cross-provider
 * silently returns garbage similarity scores — see CRG v2.3.3 security
 * hardening, which refuses to mix indexes built with different providers.
 *
 * The fix is one of:
 *   - switch the active provider config back to the one that built the index, or
 *   - run `embed_repo({ force: true })` to drop and re-embed under the new
 *     provider.
 */
export class ProviderMismatchError extends Error {
  constructor(
    public readonly stored: { provider: string; model: string },
    public readonly active: { provider: string; model: string },
  ) {
    super(
      `Embedding provider mismatch: index was built with ${stored.provider}/${stored.model}, ` +
        `current config uses ${active.provider}/${active.model}. ` +
        `Run embed_repo with force=true to re-embed under the new provider, ` +
        `or revert the AI provider config to match the index.`,
    );
    this.name = 'ProviderMismatchError';
  }
}

export type ProviderCheckResult =
  | { kind: 'ok' }
  | { kind: 'no_index' }
  | {
      kind: 'mismatch';
      stored: { provider: string; model: string };
      active: { provider: string; model: string };
    };

export class BlobVectorStore implements VectorStore {
  /** Cached expected dim — null until first getMeta() or setMeta(). */
  private cachedDim: number | null = null;

  constructor(private db: Database.Database) {
    this.ensureTable();
    const meta = this.getMeta();
    if (meta) this.cachedDim = meta.dim;
  }

  private ensureTable(): void {
    this.db.exec(CREATE_TABLE);
  }

  insert(id: number, vector: number[]): void {
    if (this.cachedDim !== null && vector.length !== this.cachedDim) {
      throw new DimensionMismatchError(this.cachedDim, vector.length);
    }
    const buf = Buffer.from(new Float32Array(vector).buffer);
    this.db
      .prepare('INSERT OR REPLACE INTO symbol_embeddings (symbol_id, embedding) VALUES (?, ?)')
      .run(id, buf);
  }

  search(query: number[], limit: number): { id: number; score: number }[] {
    if (this.cachedDim !== null && query.length !== this.cachedDim) return [];

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
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM symbol_embeddings').get() as {
      cnt: number;
    };
    return row.cnt;
  }

  clear(): void {
    this.db.exec('DELETE FROM symbol_embeddings');
  }

  setMeta(model: string, dim: number, provider?: string): void {
    const upsert = this.db.prepare(
      'INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)',
    );
    const tx = this.db.transaction(() => {
      upsert.run('model', model);
      upsert.run('dim', String(dim));
      if (provider !== undefined) {
        upsert.run('provider', provider);
      }
    });
    tx();
    this.cachedDim = dim;
  }

  getMeta(): { model: string; dim: number; provider?: string } | null {
    const rows = this.db
      .prepare("SELECT key, value FROM embedding_meta WHERE key IN ('model', 'dim', 'provider')")
      .all() as { key: string; value: string }[];
    if (rows.length < 2) return null;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const model = map.get('model');
    const dimStr = map.get('dim');
    const provider = map.get('provider');
    if (model === undefined || dimStr === undefined) return null;
    const dim = parseInt(dimStr, 10);
    if (!Number.isFinite(dim) || dim <= 0) return null;
    return provider !== undefined ? { model, dim, provider } : { model, dim };
  }

  /**
   * Compare the (provider, model) the index was built with against the
   * currently-active provider/model and report mismatch.
   *
   * Older indexes that pre-date the provider column return `kind: 'ok'` —
   * we don't have the data to tell, and refusing every legacy index would
   * surprise users. The provider column gets backfilled the next time
   * embed_repo runs.
   */
  checkProviderMatch(active: { provider: string; model: string }): ProviderCheckResult {
    const stored = this.getMeta();
    if (!stored) return { kind: 'no_index' };
    // Legacy index without a provider column — accept and let setMeta
    // backfill on the next embed_repo run.
    if (stored.provider === undefined) return { kind: 'ok' };
    if (stored.provider === active.provider && stored.model === active.model) {
      return { kind: 'ok' };
    }
    return {
      kind: 'mismatch',
      stored: { provider: stored.provider, model: stored.model },
      active,
    };
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
