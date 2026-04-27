/**
 * AI layer factory — creates the appropriate provider based on config.
 * Returns FallbackProvider when AI is disabled.
 *
 * OpenAI-compatible providers (LM Studio, Groq, Together, DeepSeek, Mistral, xAI)
 * all reuse OpenAIProvider with different default base URLs and models.
 */
import type { TraceMcpConfig } from '../config.js';
import { logger } from '../logger.js';
import { AnthropicProvider } from './anthropic.js';
import { FallbackProvider } from './fallback.js';
import { GeminiProvider } from './gemini.js';
import type {
  AIProvider,
  ChatMessage,
  EmbeddingService,
  EmbeddingTask,
  InferenceService,
} from './interfaces.js';
import { OllamaProvider } from './ollama.js';
import { OnnxProvider } from './onnx.js';
import { OpenAIProvider } from './openai.js';
import { aiTracker } from './tracker.js';
import { VertexAIProvider } from './vertex.js';
import { VoyageProvider } from './voyage.js';

/** Treat empty/whitespace strings as unset — settings UI persists cleared fields as "". */
const pick = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v : fallback;

/** Default configurations for OpenAI-compatible providers. */
const OPENAI_COMPAT_DEFAULTS: Record<
  string,
  {
    baseUrl: string;
    embeddingModel: string;
    embeddingDimensions: number;
    inferenceModel: string;
    fastModel: string;
    envKey: string;
  }
> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    embeddingModel: 'text-embedding-3-small',
    embeddingDimensions: 1536,
    inferenceModel: 'gpt-4o-mini',
    fastModel: 'gpt-4o-mini',
    envKey: 'OPENAI_API_KEY',
  },
  lmstudio: {
    baseUrl: 'http://localhost:1234/v1',
    embeddingModel: 'nomic-embed-text-v1.5',
    embeddingDimensions: 768,
    inferenceModel: 'qwen2.5-coder-7b-instruct',
    fastModel: 'qwen2.5-coder-7b-instruct',
    envKey: 'LMSTUDIO_API_KEY',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    embeddingModel: 'nomic-embed-text-v1.5',
    embeddingDimensions: 768,
    inferenceModel: 'llama-3.3-70b-versatile',
    fastModel: 'llama-3.1-8b-instant',
    envKey: 'GROQ_API_KEY',
  },
  together: {
    baseUrl: 'https://api.together.xyz/v1',
    embeddingModel: 'togethercomputer/m2-bert-80M-8k-retrieval',
    embeddingDimensions: 768,
    inferenceModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    fastModel: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
    envKey: 'TOGETHER_API_KEY',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    embeddingModel: 'deepseek-chat',
    embeddingDimensions: 1536,
    inferenceModel: 'deepseek-chat',
    fastModel: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    embeddingModel: 'mistral-embed',
    embeddingDimensions: 1024,
    inferenceModel: 'mistral-small-latest',
    fastModel: 'mistral-small-latest',
    envKey: 'MISTRAL_API_KEY',
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    embeddingModel: 'grok-4',
    embeddingDimensions: 1536,
    inferenceModel: 'grok-4',
    fastModel: 'grok-4',
    envKey: 'XAI_API_KEY',
  },
};

// ── Tracked wrappers ─────────────────────────────────────────────────
class TrackedEmbeddingService implements EmbeddingService {
  constructor(
    private inner: EmbeddingService,
    private provider: string,
    private model: string,
    private url: string,
  ) {}

  async embed(text: string, task?: EmbeddingTask): Promise<number[]> {
    const entry = aiTracker.start('embed', this.provider, this.model, this.url, text.length);
    const t0 = Date.now();
    try {
      const result = await this.inner.embed(text, task);
      aiTracker.finish(entry, 'ok', Date.now() - t0, result.length);
      return result;
    } catch (err: any) {
      aiTracker.finish(entry, 'error', Date.now() - t0, 0, err?.message ?? String(err));
      throw err;
    }
  }

  async embedBatch(texts: string[], task?: EmbeddingTask): Promise<number[][]> {
    const entry = aiTracker.start('embed_batch', this.provider, this.model, this.url, texts.length);
    const t0 = Date.now();
    try {
      const result = await this.inner.embedBatch(texts, task);
      aiTracker.finish(entry, 'ok', Date.now() - t0, result.length);
      return result;
    } catch (err: any) {
      aiTracker.finish(entry, 'error', Date.now() - t0, 0, err?.message ?? String(err));
      throw err;
    }
  }

  dimensions(): number {
    return this.inner.dimensions();
  }
  modelName(): string {
    return this.inner.modelName();
  }
}

class TrackedInferenceService implements InferenceService {
  constructor(
    private inner: InferenceService,
    private provider: string,
    private model: string,
    private url: string,
  ) {}

  async generate(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const entry = aiTracker.start('generate', this.provider, this.model, this.url, prompt.length);
    const t0 = Date.now();
    try {
      const result = await this.inner.generate(prompt, options);
      aiTracker.finish(entry, 'ok', Date.now() - t0, result.length);
      return result;
    } catch (err: any) {
      aiTracker.finish(entry, 'error', Date.now() - t0, 0, err?.message ?? String(err));
      throw err;
    }
  }

  async *generateStream(
    messages: ChatMessage[],
    options?: { maxTokens?: number; temperature?: number },
  ): AsyncIterable<string> {
    if (!this.inner.generateStream) {
      throw new Error('generateStream not supported');
    }
    const totalInput = messages.reduce((n, m) => n + m.content.length, 0);
    const entry = aiTracker.start(
      'generate_stream',
      this.provider,
      this.model,
      this.url,
      totalInput,
    );
    const t0 = Date.now();
    let outputLen = 0;
    try {
      for await (const chunk of this.inner.generateStream(messages, options)) {
        outputLen += chunk.length;
        yield chunk;
      }
      aiTracker.finish(entry, 'ok', Date.now() - t0, outputLen);
    } catch (err: any) {
      aiTracker.finish(entry, 'error', Date.now() - t0, outputLen, err?.message ?? String(err));
      throw err;
    }
  }
}

class TrackedAIProvider implements AIProvider {
  constructor(
    private inner: AIProvider,
    private providerName: string,
    private url: string,
  ) {}
  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
  embedding(): EmbeddingService {
    const svc = this.inner.embedding();
    return new TrackedEmbeddingService(svc, this.providerName, '(embedding)', this.url);
  }
  inference(): InferenceService {
    const svc = this.inner.inference();
    return new TrackedInferenceService(svc, this.providerName, '(inference)', this.url);
  }
  fastInference(): InferenceService {
    const svc = this.inner.fastInference();
    return new TrackedInferenceService(svc, this.providerName, '(fast)', this.url);
  }
}

function wrapWithTracking(provider: AIProvider, name: string, url: string): AIProvider {
  return new TrackedAIProvider(provider, name, url);
}

/** Gates individual capabilities based on `ai.features`. A disabled capability returns
 *  the fallback service (empty embeddings / empty inference strings), so callers need no
 *  changes — they already handle the "AI disabled" case. */
class GatedAIProvider implements AIProvider {
  private readonly fallback = new FallbackProvider();
  constructor(
    private inner: AIProvider,
    private features: { embedding: boolean; inference: boolean; fast_inference: boolean },
  ) {}
  isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }
  embedding(): EmbeddingService {
    return this.features.embedding ? this.inner.embedding() : this.fallback.embedding();
  }
  inference(): InferenceService {
    return this.features.inference ? this.inner.inference() : this.fallback.inference();
  }
  fastInference(): InferenceService {
    return this.features.fast_inference
      ? this.inner.fastInference()
      : this.fallback.fastInference();
  }
}

export function createAIProvider(config: TraceMcpConfig): AIProvider {
  if (!config.ai?.enabled) {
    return new FallbackProvider();
  }

  const features = config.ai.features ?? { embedding: true, inference: true, fast_inference: true };
  // If everything is off there's no point instantiating a real provider.
  if (!features.embedding && !features.inference && !features.fast_inference) {
    return new FallbackProvider();
  }

  const provider = config.ai.provider;

  if (provider === 'onnx') {
    return new GatedAIProvider(
      wrapWithTracking(
        new OnnxProvider({
          model: config.ai.embedding_model,
          dimensions: config.ai.embedding_dimensions,
        }),
        'onnx',
        'local',
      ),
      features,
    );
  }

  if (provider === 'ollama') {
    const url = pick(config.ai.base_url, 'http://localhost:11434');
    return new GatedAIProvider(
      wrapWithTracking(
        new OllamaProvider({
          baseUrl: url,
          embeddingModel: pick(config.ai.embedding_model, 'nomic-embed-text'),
          inferenceModel: pick(config.ai.inference_model, 'llama3.2'),
          fastModel: pick(config.ai.fast_model, 'llama3.2'),
          embeddingDimensions: config.ai.embedding_dimensions,
        }),
        'ollama',
        url,
      ),
      features,
    );
  }

  if (provider === 'gemini') {
    const apiKey = config.ai.api_key ?? process.env.GEMINI_API_KEY ?? '';
    if (!apiKey) {
      logger.warn('Gemini provider selected but no api_key configured — falling back');
      return new FallbackProvider();
    }
    return new GatedAIProvider(
      wrapWithTracking(
        new GeminiProvider({
          apiKey,
          embeddingModel: pick(config.ai.embedding_model, 'text-embedding-004'),
          embeddingDimensions: config.ai.embedding_dimensions ?? 768,
          inferenceModel: pick(config.ai.inference_model, 'gemini-2.5-flash'),
          fastModel: pick(config.ai.fast_model, 'gemini-2.5-flash'),
        }),
        'gemini',
        'https://generativelanguage.googleapis.com',
      ),
      features,
    );
  }

  if (provider === 'anthropic') {
    const apiKey = config.ai.api_key ?? process.env.ANTHROPIC_API_KEY ?? '';
    if (!apiKey) {
      logger.warn('Anthropic provider selected but no api_key configured — falling back');
      return new FallbackProvider();
    }
    return new GatedAIProvider(
      wrapWithTracking(
        new AnthropicProvider({
          apiKey,
          inferenceModel: pick(config.ai.inference_model, 'claude-sonnet-4-6'),
          fastModel: pick(config.ai.fast_model, 'claude-haiku-4-5-20251001'),
        }),
        'anthropic',
        'https://api.anthropic.com',
      ),
      features,
    );
  }

  if (provider === 'voyage') {
    const apiKey = config.ai.api_key ?? process.env.VOYAGE_API_KEY ?? '';
    if (!apiKey) {
      logger.warn('Voyage provider selected but no api_key configured — falling back');
      return new FallbackProvider();
    }
    const url = pick(config.ai.base_url, 'https://api.voyageai.com/v1');
    return new GatedAIProvider(
      wrapWithTracking(
        new VoyageProvider({
          apiKey,
          baseUrl: url,
          embeddingModel: pick(config.ai.embedding_model, 'voyage-code-3'),
          embeddingDimensions: config.ai.embedding_dimensions ?? 1024,
        }),
        'voyage',
        url,
      ),
      features,
    );
  }

  if (provider === 'vertex') {
    // Vertex requires a short-lived OAuth bearer token (from `gcloud auth
    // print-access-token` or a service-account exchange). We accept it via the
    // standard api_key slot so users don't need a new field name.
    const accessToken = config.ai.api_key ?? process.env.GOOGLE_ACCESS_TOKEN ?? '';
    const project = config.ai.vertex_project ?? process.env.GOOGLE_CLOUD_PROJECT ?? '';
    const location = pick(
      config.ai.vertex_location,
      process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1',
    );
    if (!accessToken || !project) {
      logger.warn(
        'Vertex AI provider selected but api_key (access token) or vertex_project missing — falling back',
      );
      return new FallbackProvider();
    }
    return new GatedAIProvider(
      wrapWithTracking(
        new VertexAIProvider({
          accessToken,
          project,
          location,
          embeddingModel: pick(config.ai.embedding_model, 'text-embedding-005'),
          embeddingDimensions: config.ai.embedding_dimensions ?? 768,
          inferenceModel: pick(config.ai.inference_model, 'gemini-2.5-flash'),
          fastModel: pick(config.ai.fast_model, 'gemini-2.5-flash'),
        }),
        'vertex',
        `https://${location}-aiplatform.googleapis.com`,
      ),
      features,
    );
  }

  // All OpenAI-compatible providers
  const defaults = OPENAI_COMPAT_DEFAULTS[provider];
  if (defaults) {
    const apiKey = config.ai.api_key ?? process.env[defaults.envKey] ?? '';
    // LM Studio doesn't require API key
    if (!apiKey && provider !== 'lmstudio') {
      logger.warn(`${provider} provider selected but no api_key configured — falling back`);
      return new FallbackProvider();
    }
    const url = pick(config.ai.base_url, defaults.baseUrl);
    return new GatedAIProvider(
      wrapWithTracking(
        new OpenAIProvider({
          apiKey,
          baseUrl: url,
          embeddingModel: pick(config.ai.embedding_model, defaults.embeddingModel),
          embeddingDimensions: config.ai.embedding_dimensions ?? defaults.embeddingDimensions,
          inferenceModel: pick(config.ai.inference_model, defaults.inferenceModel),
          fastModel: pick(config.ai.fast_model, defaults.fastModel),
        }),
        provider,
        url,
      ),
      features,
    );
  }

  return new FallbackProvider();
}

export { AnthropicProvider } from './anthropic.js';
export type { LLMProvider } from './ask-shared.js';
export {
  buildSystemPrompt,
  gatherContext,
  resolveProvider,
  stripContextFromMessage,
} from './ask-shared.js';
export { CachedInferenceService } from './cached-inference.js';
export { EmbeddingPipeline } from './embedding-pipeline.js';
export { FallbackProvider } from './fallback.js';
export { GeminiProvider } from './gemini.js';
export { InferenceCache } from './inference-cache.js';
export type {
  AIProvider,
  ChatMessage,
  EmbeddingService,
  InferenceService,
  RerankerService,
  VectorStore,
} from './interfaces.js';
export { OllamaProvider } from './ollama.js';
export { isOnnxAvailable, OnnxProvider } from './onnx.js';
export { OpenAIProvider } from './openai.js';
export type { PromptTemplate } from './prompts.js';
export { PROMPTS } from './prompts.js';
export { LLMReranker } from './reranker.js';
export { hybridSearch } from './search.js';
export { parseAnthropicStream, parseOllamaChatStream, parseOpenAIStream } from './sse.js';
export { SummarizationPipeline } from './summarization-pipeline.js';
export type { AIActivityStats, AIRequestEntry } from './tracker.js';
export { aiTracker } from './tracker.js';
export { BlobVectorStore } from './vector-store.js';
