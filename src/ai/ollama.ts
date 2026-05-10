/**
 * Ollama AI provider — connects to a local Ollama instance via its HTTP API.
 */

import { logger } from '../logger.js';
import { withRetry } from '../utils/retry.js';
import { isExplicitlyLocalUrl, safeFetch } from '../utils/ssrf-guard.js';
import type { AIProvider, ChatMessage, EmbeddingService, InferenceService } from './interfaces.js';
import { parseOllamaChatStream } from './sse.js';

interface OllamaConfig {
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
    const results = await this.embedBatch([text]);
    return results[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const allowPrivateNetworks = isExplicitlyLocalUrl(this.baseUrl);
    return withRetry(
      async () => {
        const resp = await safeFetch(
          `${this.baseUrl}/api/embed`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.model, input: texts }),
            signal: AbortSignal.timeout(30_000),
          },
          { allowPrivateNetworks },
        );

        if (!resp.ok) {
          throw new Error(`Ollama embed batch failed: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as { embeddings: number[][] };
        return data.embeddings;
      },
      { label: 'Ollama embeddings' },
    );
  }

  dimensions(): number {
    return this.dims;
  }

  modelName(): string {
    return this.model;
  }

  providerName(): string {
    return 'ollama';
  }
}

class OllamaInferenceService implements InferenceService {
  constructor(
    private baseUrl: string,
    private model: string,
  ) {}

  async generate(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const allowPrivateNetworks = isExplicitlyLocalUrl(this.baseUrl);
    return withRetry(
      async () => {
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

        const resp = await safeFetch(
          `${this.baseUrl}/api/generate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
          },
          { allowPrivateNetworks },
        );

        if (!resp.ok) {
          throw new Error(`Ollama generate failed: ${resp.status} ${resp.statusText}`);
        }

        const data = (await resp.json()) as { response: string };
        return data.response;
      },
      { label: 'Ollama generate' },
    );
  }

  async *generateStream(
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number },
  ): AsyncIterable<string> {
    const reqBody: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };

    if (options?.maxTokens || options?.temperature !== undefined) {
      reqBody.options = {
        ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      };
    }

    const resp = await safeFetch(
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(120_000),
      },
      { allowPrivateNetworks: isExplicitlyLocalUrl(this.baseUrl) },
    );

    if (!resp.ok) {
      throw new Error(`Ollama chat stream failed: ${resp.status} ${resp.statusText}`);
    }

    yield* parseOllamaChatStream(resp.body!);
  }
}

export class OllamaProvider implements AIProvider {
  private config: OllamaConfig;

  constructor(config: OllamaConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await safeFetch(
        `${this.config.baseUrl}/api/tags`,
        { signal: AbortSignal.timeout(2000) },
        { allowPrivateNetworks: isExplicitlyLocalUrl(this.config.baseUrl) },
      );
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
    return new OllamaInferenceService(this.config.baseUrl, this.config.inferenceModel);
  }

  fastInference(): InferenceService {
    return new OllamaInferenceService(this.config.baseUrl, this.config.fastModel);
  }
}
