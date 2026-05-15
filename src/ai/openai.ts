/**
 * OpenAI AI provider — connects to the OpenAI API (or any OpenAI-compatible endpoint).
 * Uses fetch directly; no SDK dependency required.
 */

import { logger } from '../logger.js';
import { withRetry } from '../utils/retry.js';
import { isExplicitlyLocalUrl, safeFetch } from '../utils/ssrf-guard.js';
import { combineAbortSignals } from './abort.js';
import type { AIProvider, ChatMessage, EmbeddingService, InferenceService } from './interfaces.js';
import { parseOpenAIStream } from './sse.js';

interface OpenAIConfig {
  apiKey: string;
  baseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  inferenceModel: string;
  fastModel: string;
}

class OpenAIEmbeddingService implements EmbeddingService {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private dims: number,
  ) {}

  async embed(
    text: string,
    _task?: import('./interfaces.js').EmbeddingTask,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const results = await this.embedBatch([text], undefined, signal);
    return results[0] ?? [];
  }

  async embedBatch(
    texts: string[],
    _task?: import('./interfaces.js').EmbeddingTask,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const allowPrivateNetworks = isExplicitlyLocalUrl(this.baseUrl);
    return withRetry(
      async () => {
        const resp = await safeFetch(
          `${this.baseUrl}/embeddings`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({ model: this.model, input: texts }),
            signal: combineAbortSignals(signal, AbortSignal.timeout(30_000)),
          },
          { allowPrivateNetworks },
        );

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
          throw new Error(
            `OpenAI embeddings failed: ${resp.status} ${resp.statusText} — ${safeBody}`,
          );
        }

        const data = (await resp.json()) as { data: { index: number; embedding: number[] }[] };
        const result: number[][] = new Array(texts.length).fill(null);
        for (const item of data.data) {
          result[item.index] = item.embedding;
        }
        return result;
      },
      { label: 'OpenAI embeddings' },
    );
  }

  dimensions(): number {
    return this.dims;
  }

  modelName(): string {
    return this.model;
  }

  providerName(): string {
    return 'openai';
  }
}

class OpenAIInferenceService implements InferenceService {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
  ) {}

  async generate(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<string> {
    const allowPrivateNetworks = isExplicitlyLocalUrl(this.baseUrl);
    return withRetry(
      async () => {
        const resp = await safeFetch(
          `${this.baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
              model: this.model,
              messages: [{ role: 'user', content: prompt }],
              ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
              ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
            }),
            signal: combineAbortSignals(options?.signal, AbortSignal.timeout(60_000)),
          },
          { allowPrivateNetworks },
        );

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
          throw new Error(`OpenAI chat failed: ${resp.status} ${resp.statusText} — ${safeBody}`);
        }

        const data = (await resp.json()) as { choices: { message: { content: string } }[] };
        return data.choices[0]?.message?.content ?? '';
      },
      { label: 'OpenAI chat' },
    );
  }

  async *generateStream(
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): AsyncIterable<string> {
    const resp = await safeFetch(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        }),
        signal: combineAbortSignals(options?.signal, AbortSignal.timeout(120_000)),
      },
      { allowPrivateNetworks: isExplicitlyLocalUrl(this.baseUrl) },
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
      throw new Error(`OpenAI chat stream failed: ${resp.status} ${resp.statusText} — ${safeBody}`);
    }

    yield* parseOpenAIStream(resp.body!);
  }
}

export class OpenAIProvider implements AIProvider {
  private config: OpenAIConfig;

  constructor(config: OpenAIConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await safeFetch(
        `${this.config.baseUrl}/models`,
        {
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
          signal: AbortSignal.timeout(3000),
        },
        { allowPrivateNetworks: isExplicitlyLocalUrl(this.config.baseUrl) },
      );
      return resp.ok;
    } catch {
      logger.debug('OpenAI not available');
      return false;
    }
  }

  embedding(): EmbeddingService {
    return new OpenAIEmbeddingService(
      this.config.baseUrl,
      this.config.apiKey,
      this.config.embeddingModel,
      this.config.embeddingDimensions,
    );
  }

  inference(): InferenceService {
    return new OpenAIInferenceService(
      this.config.baseUrl,
      this.config.apiKey,
      this.config.inferenceModel,
    );
  }

  fastInference(): InferenceService {
    return new OpenAIInferenceService(
      this.config.baseUrl,
      this.config.apiKey,
      this.config.fastModel,
    );
  }
}
