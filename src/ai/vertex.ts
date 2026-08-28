/**
 * Google Vertex AI provider — connects to Google Cloud's Vertex AI endpoints.
 *
 * Distinct from GeminiProvider (which hits the consumer Generative Language
 * API with a simple API key). Vertex uses:
 *   - OAuth2 bearer tokens (obtain via `gcloud auth print-access-token` or
 *     a service account JWT → token exchange). Tokens are short-lived (~1h);
 *     users refresh out-of-band.
 *   - Project + location routing (us-central1, europe-west4, etc.).
 *   - Embedding API shape: {instances:[{task_type,content}], parameters:{outputDimensionality}}
 *   - Inference API shape: same :generateContent as Gemini, just different host/auth.
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

interface VertexAIConfig {
  accessToken: string;
  project: string;
  location: string;
  embeddingModel: string;
  embeddingDimensions: number;
  inferenceModel: string;
  fastModel: string;
}

function vertexHost(location: string): string {
  return `https://${location}-aiplatform.googleapis.com`;
}

function modelUrl(
  cfg: Pick<VertexAIConfig, 'project' | 'location'>,
  model: string,
  verb: string,
): string {
  return `${vertexHost(cfg.location)}/v1/projects/${cfg.project}/locations/${cfg.location}/publishers/google/models/${model}:${verb}`;
}

class VertexAIEmbeddingService implements EmbeddingService {
  constructor(private cfg: VertexAIConfig) {}

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
        const resp = await fetch(modelUrl(this.cfg, this.cfg.embeddingModel, 'predict'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.accessToken}`,
          },
          body: JSON.stringify({
            instances: texts.map((text) => ({ task_type: taskType, content: text })),
            parameters:
              this.cfg.embeddingDimensions > 0
                ? { outputDimensionality: this.cfg.embeddingDimensions }
                : {},
          }),
          signal: combineAbortSignals(signal, AbortSignal.timeout(30_000)),
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
          throw new Error(
            `Vertex embeddings failed: ${resp.status} ${resp.statusText} — ${safeBody}`,
          );
        }

        const data = (await resp.json()) as {
          predictions: { embeddings: { values: number[] } }[];
        };
        return data.predictions.map((p) => p.embeddings.values);
      },
      { label: 'Vertex embeddings' },
    );
  }

  dimensions(): number {
    return this.cfg.embeddingDimensions;
  }

  modelName(): string {
    return this.cfg.embeddingModel;
  }

  providerName(): string {
    return 'vertex';
  }
}

class VertexAIInferenceService implements InferenceService {
  constructor(
    private cfg: VertexAIConfig,
    private model: string,
  ) {}

  async generate(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<string> {
    return withRetry(
      async () => {
        const resp = await fetch(modelUrl(this.cfg, this.model, 'generateContent'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.accessToken}`,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
              ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
            },
          }),
          signal: combineAbortSignals(options?.signal, AbortSignal.timeout(60_000)),
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
          throw new Error(
            `Vertex generate failed: ${resp.status} ${resp.statusText} — ${safeBody}`,
          );
        }

        const data = (await resp.json()) as {
          candidates: { content: { parts: { text: string }[] } }[];
        };
        return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      },
      { label: 'Vertex generate' },
    );
  }

  async *generateStream(
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): AsyncIterable<string> {
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const resp = await fetch(`${modelUrl(this.cfg, this.model, 'streamGenerateContent')}?alt=sse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.accessToken}`,
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        },
      }),
      signal: combineAbortSignals(options?.signal, AbortSignal.timeout(120_000)),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const safeBody = body.length > 200 ? `${body.slice(0, 200)}…` : body;
      throw new Error(`Vertex stream failed: ${resp.status} ${resp.statusText} — ${safeBody}`);
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

export class VertexAIProvider implements AIProvider {
  private config: VertexAIConfig;

  constructor(config: VertexAIConfig) {
    this.config = config;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.config.accessToken || !this.config.project || !this.config.location) {
      return false;
    }
    try {
      // Publisher models list is lightweight + works with the same bearer token.
      const resp = await fetch(
        `${vertexHost(this.config.location)}/v1/projects/${this.config.project}/locations/${this.config.location}/publishers/google/models`,
        {
          headers: { Authorization: `Bearer ${this.config.accessToken}` },
          signal: AbortSignal.timeout(3000),
        },
      );
      return resp.ok;
    } catch {
      logger.debug('Vertex AI not available');
      return false;
    }
  }

  embedding(): EmbeddingService {
    return new VertexAIEmbeddingService(this.config);
  }

  inference(): InferenceService {
    return new VertexAIInferenceService(this.config, this.config.inferenceModel);
  }

  fastInference(): InferenceService {
    return new VertexAIInferenceService(this.config, this.config.fastModel);
  }
}
