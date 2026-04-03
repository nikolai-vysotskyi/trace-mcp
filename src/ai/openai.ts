/**
 * OpenAI AI provider — connects to the OpenAI API (or any OpenAI-compatible endpoint).
 * Uses fetch directly; no SDK dependency required.
 */
import type { AIProvider, EmbeddingService, InferenceService } from './interfaces.js';
import { logger } from '../logger.js';

export interface OpenAIConfig {
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

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      // Truncate body to avoid leaking sensitive data in error messages
      const safeBody = body.length > 200 ? body.slice(0, 200) + '…' : body;
      throw new Error(`OpenAI embeddings failed: ${resp.status} ${resp.statusText} — ${safeBody}`);
    }

    const data = (await resp.json()) as { data: { index: number; embedding: number[] }[] };
    // OpenAI returns data sorted by index, but let's be safe
    const result: number[][] = new Array(texts.length).fill(null);
    for (const item of data.data) {
      result[item.index] = item.embedding;
    }
    return result;
  }

  dimensions(): number {
    return this.dims;
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
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
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
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const safeBody = body.length > 200 ? body.slice(0, 200) + '…' : body;
      throw new Error(`OpenAI chat failed: ${resp.status} ${resp.statusText} — ${safeBody}`);
    }

    const data = (await resp.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? '';
  }
}

export class OpenAIProvider implements AIProvider {
  private config: OpenAIConfig;

  constructor(config: OpenAIConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
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
