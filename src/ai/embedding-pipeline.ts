/**
 * Lazy background embedding indexer.
 * Finds symbols without embeddings and indexes them in batches.
 */
import type { Store } from '../db/store.js';
import type { EmbeddingService, VectorStore } from './interfaces.js';
import type { ProgressState } from '../progress.js';
import { logger } from '../logger.js';

const DEFAULT_BATCH_SIZE = 50;

export class EmbeddingPipeline {
  constructor(
    private store: Store,
    private embeddingService: EmbeddingService,
    private vectorStore: VectorStore,
    private progress?: ProgressState,
  ) {}

  async indexSymbol(symbolId: number, text: string): Promise<void> {
    const embedding = await this.embeddingService.embed(text);
    if (embedding.length > 0) {
      this.vectorStore.insert(symbolId, embedding);
    }
  }

  /**
   * Find symbols that don't have embeddings yet and embed them in a loop.
   * Reports progress and returns the total number of newly embedded symbols.
   */
  async indexUnembedded(batchSize = DEFAULT_BATCH_SIZE): Promise<number> {
    const totalToEmbed = this.store.countUnembeddedSymbols();
    if (totalToEmbed === 0) return 0;

    this.progress?.update('embedding', {
      phase: 'running', processed: 0, total: totalToEmbed, startedAt: Date.now(), completedAt: 0,
    });

    let totalIndexed = 0;

    try {
      let batch: number;
      do {
        batch = await this.embedBatch(batchSize);
        totalIndexed += batch;
        if (batch > 0) {
          this.progress?.update('embedding', { processed: totalIndexed });
        }
      } while (batch > 0);

      this.progress?.update('embedding', {
        phase: 'completed', processed: totalIndexed, completedAt: Date.now(),
      });
    } catch (e) {
      this.progress?.update('embedding', {
        phase: 'error', error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    return totalIndexed;
  }

  /**
   * Embed a single batch of unembedded symbols.
   * Returns the number of symbols embedded in this batch.
   */
  private async embedBatch(batchSize: number): Promise<number> {
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
    return this.indexUnembedded(DEFAULT_BATCH_SIZE);
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
