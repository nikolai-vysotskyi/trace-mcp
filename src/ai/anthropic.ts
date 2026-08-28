/**
 * Anthropic AI provider — connects to the Claude Messages API.
 * Inference-only: Claude does not offer an embeddings API,
 * so embedding() returns a FallbackEmbeddingService (use a separate
 * embedding provider or pair with ONNX for embeddings).
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
import { parseAnthropicStream } from './sse.js';

interface AnthropicConfig {
  apiKey: string;
  inferenceModel: string;
  fastModel: string;
}

const BASE_URL = 'https://api.anthropic.com';

class NoEmbeddingService implements EmbeddingService {
  async embed(_text: string, _task?: EmbeddingTask, _signal?: AbortSignal): Promise<number[]> {
    return [];
  }
  async embedBatch(
    _texts: string[],
    _task?: EmbeddingTask,
    _signal?: AbortSignal,
  ): Promise<number[][]> {
    return [];
  }
  dimensions(): number {
    return 0;
  }
  modelName(): string {
    return '';
  }
  providerName(): string {
    return 'anthropic-noop';
  }
}

class AnthropicInferenceService implements InferenceService {
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
        const resp = await fetch(`${BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: options?.maxTokens ?? 4096,
            messages: [{ role: 'user', content: prompt }],
            ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          }),
          signal: combineAbortSignals(options?.signal, AbortSignal.timeout(60_000)),
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
          throw new Error(`Anthropic API error: ${resp.status} ${resp.statusText} — ${safeBody}`);
        }

        const data = (await resp.json()) as {
          content: { type: string; text?: string }[];
        };
        return data.content?.find((c) => c.type === 'text')?.text ?? '';
      },
      { label: 'Anthropic generate' },
    );
  }

  async *generateStream(
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): AsyncIterable<string> {
    const systemMsg = messages.find((m) => m.role === 'system');
    const nonSystemMsgs = messages.filter((m) => m.role !== 'system');

    const resp = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options?.maxTokens ?? 4096,
        stream: true,
        ...(systemMsg ? { system: systemMsg.content } : {}),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal: combineAbortSignals(options?.signal, AbortSignal.timeout(120_000)),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
      throw new Error(`Anthropic stream error: ${resp.status} ${resp.statusText} — ${safeBody}`);
    }

    yield* parseAnthropicStream(resp.body!);
  }
}

export class AnthropicProvider implements AIProvider {
  private config: AnthropicConfig;

  constructor(config: AnthropicConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Lightweight check — just verify the key is accepted
      const resp = await fetch(`${BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.config.inferenceModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(5000),
      });
      // 200 = success, 400 = bad request but auth works
      return resp.ok || resp.status === 400;
    } catch {
      logger.debug('Anthropic not available');
      return false;
    }
  }

  embedding(): EmbeddingService {
    logger.warn(
      'Anthropic does not provide embeddings — use a separate embedding provider (ONNX, Ollama, or OpenAI)',
    );
    return new NoEmbeddingService();
  }

  inference(): InferenceService {
    return new AnthropicInferenceService(this.config.apiKey, this.config.inferenceModel);
  }

  fastInference(): InferenceService {
    return new AnthropicInferenceService(this.config.apiKey, this.config.fastModel);
  }
}
