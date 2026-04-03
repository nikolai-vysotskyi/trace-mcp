/**
 * Lazy background embedding indexer.
 * Finds symbols without embeddings and indexes them in batches.
 */
import type { Store } from '../db/store.js';
import type { EmbeddingService, VectorStore } from './interfaces.js';
import { logger } from '../logger.js';

const DEFAULT_BATCH_SIZE = 50;

export class EmbeddingPipeline {
  constructor(
    private store: Store,
    private embeddingService: EmbeddingService,
    private vectorStore: VectorStore,
  ) {}

  async indexSymbol(symbolId: number, text: string): Promise<void> {
    const embedding = await this.embeddingService.embed(text);
    if (embedding.length > 0) {
      this.vectorStore.insert(symbolId, embedding);
    }
  }

  /**
   * Find symbols that don't have embeddings yet and embed them.
   * Returns the number of newly embedded symbols.
   */
  async indexUnembedded(batchSize = DEFAULT_BATCH_SIZE): Promise<number> {
    const unembedded = this.store.db.prepare(`
      SELECT s.id, s.name, s.fqn, s.kind, s.signature, s.summary
      FROM symbols s
      LEFT JOIN symbol_embeddings se ON se.symbol_id = s.id
      WHERE se.symbol_id IS NULL
      LIMIT ?
    `).all(batchSize) as {
      id: number;
      name: string;
      fqn: string | null;
      kind: string;
      signature: string | null;
      summary: string | null;
    }[];

    if (unembedded.length === 0) return 0;

    const texts = unembedded.map((s) => buildEmbeddingText(s));
    let indexed = 0;

    try {
      const embeddings = await this.embeddingService.embedBatch(texts);
      for (let i = 0; i < embeddings.length; i++) {
        if (embeddings[i].length > 0) {
          this.vectorStore.insert(unembedded[i].id, embeddings[i]);
          indexed++;
        }
      }
    } catch (e) {
      logger.error({ error: e }, 'Embedding batch failed');
    }

    logger.debug({ indexed, total: unembedded.length }, 'Indexed unembedded symbols');
    return indexed;
  }

  /**
   * Re-embed all symbols (deletes existing embeddings first).
   * Returns the number of embedded symbols.
   */
  async reindexAll(): Promise<number> {
    this.store.db.exec('DELETE FROM symbol_embeddings');

    let total = 0;
    let batch: number;
    do {
      batch = await this.indexUnembedded(DEFAULT_BATCH_SIZE);
      total += batch;
    } while (batch > 0);

    return total;
  }
}

function buildEmbeddingText(symbol: {
  name: string;
  fqn: string | null;
  kind: string;
  signature: string | null;
  summary: string | null;
}): string {
  const parts = [symbol.kind, symbol.fqn ?? symbol.name];
  if (symbol.signature) parts.push(symbol.signature);
  if (symbol.summary) parts.push(symbol.summary);
  return parts.join(' ');
}
