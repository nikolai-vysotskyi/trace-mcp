/**
 * Ollama AI provider — connects to a local Ollama instance via its HTTP API.
 */

import { logger } from '../logger.js';
import { withRetry } from '../utils/retry.js';
import { isExplicitlyLocalUrl, safeFetch } from '../utils/ssrf-guard.js';
import { combineAbortSignals } from './abort.js';
import type {
  AIProvider,
  ChatMessage,
  EmbeddingService,
  EmbeddingTask,
  InferenceService,
} from './interfaces.js';
import { parseOllamaChatStream } from './sse.js';

interface OllamaConfig {
  baseUrl: string;
  embeddingModel: string;
  inferenceModel: string;
  fastModel: string;
  embeddingDimensions?: number;
}

class OllamaEmbeddingService implements EmbeddingService {
  /**
   * Resolved dimension. Seeded from the explicitly configured value; when none
   * is configured it starts at the fallback default and is overwritten with the
   * model's real vector length after the first embed or an explicit probe.
   */
  private dims: number;
  /** True once we've adopted a dimension from a real embedding response. */
  private detected: boolean;

  constructor(
    private baseUrl: string,
    private model: string,
    /**
     * Dimension from `ai.embedding_dimensions`. A positive value is trusted and
     * pins the dimension (no auto-detection). When undefined / 0 we auto-detect
     * from the model's real output instead of trusting {@link fallbackDims}.
     */
    configuredDims: number | undefined,
    private fallbackDims = 768,
  ) {
    if (configuredDims && configuredDims > 0) {
      // Operator pinned the dimension explicitly — trust it, never auto-detect.
      this.dims = configuredDims;
      this.detected = true;
    } else {
      // No explicit config: use the fallback until a real response reveals the
      // model's true dimensionality (probeDimensions or the first embedBatch).
      this.dims = fallbackDims;
      this.detected = false;
    }
  }

  async embed(text: string, _task?: EmbeddingTask, signal?: AbortSignal): Promise<number[]> {
    const results = await this.embedBatch([text], undefined, signal);
    return results[0] ?? [];
  }

  async embedBatch(
    texts: string[],
    _task?: EmbeddingTask,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const allowPrivateNetworks = isExplicitlyLocalUrl(this.baseUrl);
    const embeddings = await withRetry(
      async () => {
        const resp = await safeFetch(
          `${this.baseUrl}/api/embed`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: this.model, input: texts }),
            signal: combineAbortSignals(signal, AbortSignal.timeout(30_000)),
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
    this.adoptDimension(embeddings[0]?.length);
    return embeddings;
  }

  /**
   * When the dimension wasn't pinned in config, learn it from a real embedding
   * response so the vector store gets stamped with the model's true dimension
   * rather than the blanket fallback default.
   */
  private adoptDimension(vectorLength: number | undefined): void {
    if (this.detected) return;
    if (typeof vectorLength === 'number' && vectorLength > 0) {
      if (vectorLength !== this.dims) {
        logger.info(
          { model: this.model, detected: vectorLength, fallback: this.fallbackDims },
          'Ollama embedding dimension auto-detected from model output',
        );
      }
      this.dims = vectorLength;
      this.detected = true;
    }
  }

  async probeDimensions(signal?: AbortSignal): Promise<number> {
    if (this.detected) return this.dims;
    try {
      const [vec] = await this.embedBatch(['probe'], undefined, signal);
      // adoptDimension already ran inside embedBatch; fall back defensively.
      if (vec && vec.length > 0) return vec.length;
    } catch (e) {
      logger.warn(
        { error: e, model: this.model },
        'Ollama embedding dimension probe failed — using fallback default',
      );
    }
    return this.detected ? this.dims : 0;
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
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
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
            signal: combineAbortSignals(options?.signal, AbortSignal.timeout(60_000)),
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
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
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
        signal: combineAbortSignals(options?.signal, AbortSignal.timeout(120_000)),
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
    // Pass the configured dimension through untouched (undefined when unset) so
    // the service auto-detects the model's real dimension instead of blindly
    // stamping the 768 fallback — many Ollama models (e.g. qwen3-embedding:0.6b
    // at 1024) differ, and a wrong stamp makes every insert fail silently.
    return new OllamaEmbeddingService(
      this.config.baseUrl,
      this.config.embeddingModel,
      this.config.embeddingDimensions,
    );
  }

  inference(): InferenceService {
    return new OllamaInferenceService(this.config.baseUrl, this.config.inferenceModel);
  }

  fastInference(): InferenceService {
    return new OllamaInferenceService(this.config.baseUrl, this.config.fastModel);
  }
}
