/**
 * Voyage AI provider — embedding-only.
 * Voyage specializes in retrieval-grade embedding models (voyage-code-3,
 * voyage-3-large, etc.). No inference API — callers should pair Voyage with
 * a separate inference provider (Anthropic, OpenAI, Ollama) if summarization
 * or reasoning is needed.
 */

import { logger } from '../logger.js';
import { withRetry } from '../utils/retry.js';
import { FallbackInferenceService } from './fallback.js';
import type {
  AIProvider,
  EmbeddingService,
  EmbeddingTask,
  InferenceService,
} from './interfaces.js';

interface VoyageConfig {
  apiKey: string;
  baseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
}

const DEFAULT_BASE_URL = 'https://api.voyageai.com/v1';

class VoyageEmbeddingService implements EmbeddingService {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private dims: number,
  ) {}

  async embed(text: string, task?: EmbeddingTask): Promise<number[]> {
    const results = await this.embedBatch([text], task);
    return results[0] ?? [];
  }

  async embedBatch(texts: string[], task: EmbeddingTask = 'document'): Promise<number[][]> {
    return withRetry(
      async () => {
        const body: Record<string, unknown> = {
          model: this.model,
          input: texts,
          // Voyage uses distinct asymmetric embeddings for indexing vs retrieval;
          // 'document' embeds corpus content, 'query' embeds user search strings.
          input_type: task,
        };
        // voyage-3.5 family supports Matryoshka truncation via output_dimension.
        // Older models ignore this field.
        if (this.dims > 0) body.output_dimension = this.dims;

        const resp = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) {
          const payload = await resp.text().catch(() => '');
          const safePayload = payload.length > 200 ? `${payload.slice(0, 200)}…` : payload;
          throw new Error(
            `Voyage embeddings failed: ${resp.status} ${resp.statusText} — ${safePayload}`,
          );
        }

        const data = (await resp.json()) as { data: { index: number; embedding: number[] }[] };
        const result: number[][] = new Array(texts.length).fill(null);
        for (const item of data.data) {
          result[item.index] = item.embedding;
        }
        return result;
      },
      { label: 'Voyage embeddings' },
    );
  }

  dimensions(): number {
    return this.dims;
  }

  modelName(): string {
    return this.model;
  }
}

export class VoyageProvider implements AIProvider {
  private config: VoyageConfig;

  constructor(config: VoyageConfig) {
    this.config = { ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URL };
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Voyage has no lightweight health endpoint — a 1-token embed is the
      // smallest probe that exercises auth + routing.
      const resp = await fetch(`${this.config.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ model: this.config.embeddingModel, input: ['ping'] }),
        signal: AbortSignal.timeout(5000),
      });
      return resp.ok;
    } catch {
      logger.debug('Voyage not available');
      return false;
    }
  }

  embedding(): EmbeddingService {
    return new VoyageEmbeddingService(
      this.config.baseUrl,
      this.config.apiKey,
      this.config.embeddingModel,
      this.config.embeddingDimensions,
    );
  }

  inference(): InferenceService {
    logger.warn(
      'Voyage does not provide inference — pair it with Anthropic/OpenAI/Ollama for summarization',
    );
    return new FallbackInferenceService();
  }

  fastInference(): InferenceService {
    return new FallbackInferenceService();
  }
}
