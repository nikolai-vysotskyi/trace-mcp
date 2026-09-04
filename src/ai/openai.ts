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
  /**
   * Extra fields merged into every /chat/completions and /responses request
   * body. Sourced from `ai.openaiExtraBody` (config) merged over
   * TRACE_MCP_OPENAI_EXTRA_BODY (env). Core fields always win over this.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Configured provider name for log lines ('lmstudio', 'groq', …). This class
   * serves every OpenAI-compatible endpoint, so hard-coding "OpenAI" in the
   * retry/error text pointed diagnosis at an API-key problem when the real
   * cause was a local LM Studio process that wasn't running (TRA-812).
   * Display only — `providerName()` deliberately stays 'openai' because it is
   * stamped into the vector store and changing it would drop existing indexes.
   */
  providerLabel?: string;
}

/**
 * Parse TRACE_MCP_OPENAI_EXTRA_BODY (a JSON object string) defensively. Bad
 * JSON or a non-object value is warned about and ignored — never thrown — so a
 * typo in the env can't take down the indexer.
 */
export function parseOpenAIExtraBodyEnv(
  raw: string | undefined = process.env.TRACE_MCP_OPENAI_EXTRA_BODY,
): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn('TRACE_MCP_OPENAI_EXTRA_BODY is not a JSON object — ignoring');
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    logger.warn(
      { error: e instanceof Error ? e.message : String(e) },
      'TRACE_MCP_OPENAI_EXTRA_BODY is not valid JSON — ignoring',
    );
    return {};
  }
}

/**
 * Resolve the effective extra body: env first, then config layered on top so
 * config wins on per-key conflicts. Either side may be omitted.
 */
export function resolveOpenAIExtraBody(
  configExtra?: Record<string, unknown>,
  envExtra: Record<string, unknown> = parseOpenAIExtraBodyEnv(),
): Record<string, unknown> {
  return { ...envExtra, ...(configExtra ?? {}) };
}

/**
 * Origin + path of `baseUrl`, with any userinfo and query string dropped. The
 * URL goes into log lines and thrown errors, and some OpenAI-compatible
 * gateways carry a token in userinfo or `?key=` — those must not reach the log.
 * Unparseable input degrades to the scheme+host prefix, never the raw string.
 */
export function redactBaseUrlForLogs(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return '<invalid base_url>';
  }
}

class OpenAIEmbeddingService implements EmbeddingService {
  /** e.g. "lmstudio embeddings @ http://localhost:1234/v1" — used in logs only. */
  private readonly label: string;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private dims: number,
    providerLabel = 'openai',
  ) {
    this.label = `${providerLabel} embeddings @ ${redactBaseUrlForLogs(baseUrl)}`;
  }

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
          throw new Error(`${this.label} failed: ${resp.status} ${resp.statusText} — ${safeBody}`);
        }

        const data = (await resp.json()) as { data: { index: number; embedding: number[] }[] };
        const result: number[][] = new Array(texts.length).fill(null);
        for (const item of data.data) {
          result[item.index] = item.embedding;
        }
        return result;
      },
      { label: this.label },
    );
  }

  dimensions(): number {
    return this.dims;
  }

  modelName(): string {
    return this.model;
  }

  /**
   * Wire-format identity, not the configured provider name. Stamped into the
   * vector store meta — returning 'lmstudio' here would look like a provider
   * change and drop every existing index built via an OpenAI-compatible
   * endpoint. Log lines use `this.label` instead.
   */
  providerName(): string {
    return 'openai';
  }
}

class OpenAIInferenceService implements InferenceService {
  /** e.g. "lmstudio chat @ http://localhost:1234/v1" — used in logs only. */
  private readonly label: string;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    /** Merged config+env extra body fields; core request fields win over these. */
    private extraBody: Record<string, unknown> = {},
    providerLabel = 'openai',
  ) {
    this.label = `${providerLabel} chat @ ${redactBaseUrlForLogs(baseUrl)}`;
  }

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
            // Spread extraBody FIRST so the core fields below always win on conflict.
            body: JSON.stringify({
              ...this.extraBody,
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
          throw new Error(`${this.label} failed: ${resp.status} ${resp.statusText} — ${safeBody}`);
        }

        const data = (await resp.json()) as { choices: { message: { content: string } }[] };
        return data.choices[0]?.message?.content ?? '';
      },
      { label: this.label },
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
        // Spread extraBody FIRST so the core fields below always win on conflict.
        body: JSON.stringify({
          ...this.extraBody,
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
      throw new Error(
        `${this.label} stream failed: ${resp.status} ${resp.statusText} — ${safeBody}`,
      );
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
      this.config.providerLabel,
    );
  }

  inference(): InferenceService {
    return new OpenAIInferenceService(
      this.config.baseUrl,
      this.config.apiKey,
      this.config.inferenceModel,
      this.config.extraBody,
      this.config.providerLabel,
    );
  }

  fastInference(): InferenceService {
    return new OpenAIInferenceService(
      this.config.baseUrl,
      this.config.apiKey,
      this.config.fastModel,
      this.config.extraBody,
      this.config.providerLabel,
    );
  }
}
