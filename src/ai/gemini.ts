/**
 * Google Gemini AI provider — connects to the Gemini REST API.
 * Supports embeddings (text-embedding-004) and inference (gemini-2.0-flash, etc.).
 * Uses fetch directly; no SDK dependency required.
 */

import { logger } from '../logger.js';
import { withRetry } from '../utils/retry.js';
import { combineAbortSignals } from './abort.js';
import type {
  AIProvider,
  ChatMessage,
  EmbeddingService,
  EmbeddingTask,
  InferenceService,
} from './interfaces.js';

interface GeminiConfig {
  apiKey: string;
  embeddingModel: string;
  embeddingDimensions: number;
  inferenceModel: string;
  fastModel: string;
}

const BASE_URL = 'https://generativelanguage.googleapis.com';

class GeminiEmbeddingService implements EmbeddingService {
  constructor(
    private apiKey: string,
    private model: string,
    private dims: number,
  ) {}

  async embed(text: string, task?: EmbeddingTask, signal?: AbortSignal): Promise<number[]> {
    const results = await this.embedBatch([text], task, signal);
    return results[0] ?? [];
  }

  async embedBatch(
    texts: string[],
    task: EmbeddingTask = 'document',
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const taskType = task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
    return withRetry(
      async () => {
        // Gemini batch embed API
        const requests = texts.map((text) => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: this.dims,
          taskType,
        }));

        const resp = await fetch(
          `${BASE_URL}/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requests }),
            signal: combineAbortSignals(signal, AbortSignal.timeout(30_000)),
          },
        );

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
          throw new Error(
            `Gemini embeddings failed: ${resp.status} ${resp.statusText} — ${safeBody}`,
          );
        }

        const data = (await resp.json()) as { embeddings: { values: number[] }[] };
        return data.embeddings.map((e) => e.values);
      },
      { label: 'Gemini embeddings' },
    );
  }

  dimensions(): number {
    return this.dims;
  }

  modelName(): string {
    return this.model;
  }

  providerName(): string {
    return 'gemini';
  }
}

class GeminiInferenceService implements InferenceService {
  constructor(
    private apiKey: string,
    private model: string,
  ) {}

  async generate(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<string> {
    return withRetry(
      async () => {
        const resp = await fetch(
          `${BASE_URL}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
                ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
              },
            }),
            signal: combineAbortSignals(options?.signal, AbortSignal.timeout(60_000)),
          },
        );

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
          throw new Error(
            `Gemini generate failed: ${resp.status} ${resp.statusText} — ${safeBody}`,
          );
        }

        const data = (await resp.json()) as {
          candidates: { content: { parts: { text: string }[] } }[];
        };
        return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      },
      { label: 'Gemini generate' },
    );
  }

  async *generateStream(
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): AsyncIterable<string> {
    // Convert ChatMessage[] to Gemini format
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const resp = await fetch(
      `${BASE_URL}/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
            ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          },
        }),
        signal: combineAbortSignals(options?.signal, AbortSignal.timeout(120_000)),
      },
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
      throw new Error(`Gemini stream failed: ${resp.status} ${resp.statusText} — ${safeBody}`);
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (!json || json === '[DONE]') continue;
        try {
          const chunk = JSON.parse(json) as {
            candidates?: { content?: { parts?: { text?: string }[] } }[];
          };
          const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) yield text;
        } catch {
          /* skip unparseable */
        }
      }
    }
  }
}

export class GeminiProvider implements AIProvider {
  private config: GeminiConfig;

  constructor(config: GeminiConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${BASE_URL}/v1beta/models?key=${this.config.apiKey}`, {
        signal: AbortSignal.timeout(3000),
      });
      return resp.ok;
    } catch {
      logger.debug('Gemini not available');
      return false;
    }
  }

  embedding(): EmbeddingService {
    return new GeminiEmbeddingService(
      this.config.apiKey,
      this.config.embeddingModel,
      this.config.embeddingDimensions,
    );
  }

  inference(): InferenceService {
    return new GeminiInferenceService(this.config.apiKey, this.config.inferenceModel);
  }

  fastInference(): InferenceService {
    return new GeminiInferenceService(this.config.apiKey, this.config.fastModel);
  }
}
