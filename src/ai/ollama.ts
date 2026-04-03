/**
 * Ollama AI provider — connects to a local Ollama instance via its HTTP API.
 */
import type { AIProvider, EmbeddingService, InferenceService } from './interfaces.js';
import { logger } from '../logger.js';

export interface OllamaConfig {
  baseUrl: string;
  embeddingModel: string;
  inferenceModel: string;
  fastModel: string;
  embeddingDimensions?: number;
}

class OllamaEmbeddingService implements EmbeddingService {
  constructor(
    private baseUrl: string,
    private model: string,
    private dims: number,
  ) {}

  async embed(text: string): Promise<number[]> {
    const resp = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!resp.ok) {
      throw new Error(`Ollama embed failed: ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as { embeddings: number[][] };
    return data.embeddings[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!resp.ok) {
      throw new Error(`Ollama embed batch failed: ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as { embeddings: number[][] };
    return data.embeddings;
  }

  dimensions(): number {
    return this.dims;
  }
}

class OllamaInferenceService implements InferenceService {
  constructor(
    private baseUrl: string,
    private model: string,
  ) {}

  async generate(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      prompt,
      stream: false,
    };

    if (options?.maxTokens || options?.temperature !== undefined) {
      body.options = {
        ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      };
    }

    const resp = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`Ollama generate failed: ${resp.status} ${resp.statusText}`);
    }

    const data = (await resp.json()) as { response: string };
    return data.response;
  }
}

export class OllamaProvider implements AIProvider {
  private config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      return resp.ok;
    } catch {
      logger.debug('Ollama not available');
      return false;
    }
  }

  embedding(): EmbeddingService {
    return new OllamaEmbeddingService(
      this.config.baseUrl,
      this.config.embeddingModel,
      this.config.embeddingDimensions ?? 768,
    );
  }

  inference(): InferenceService {
    return new OllamaInferenceService(
      this.config.baseUrl,
      this.config.inferenceModel,
    );
  }
}
