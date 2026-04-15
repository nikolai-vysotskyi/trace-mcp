/**
 * AI layer factory — creates the appropriate provider based on config.
 * Returns FallbackProvider when AI is disabled.
 *
 * OpenAI-compatible providers (LM Studio, Groq, Together, DeepSeek, Mistral, xAI)
 * all reuse OpenAIProvider with different default base URLs and models.
 */
import type { TraceMcpConfig } from '../config.js';
import type { AIProvider } from './interfaces.js';
import { FallbackProvider } from './fallback.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import { OnnxProvider } from './onnx.js';
import { GeminiProvider } from './gemini.js';
import { AnthropicProvider } from './anthropic.js';
import { logger } from '../logger.js';

/** Default configurations for OpenAI-compatible providers. */
const OPENAI_COMPAT_DEFAULTS: Record<string, {
  baseUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  inferenceModel: string;
  fastModel: string;
  envKey: string;
}> = {
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
    embeddingModel: 'grok-2',
    embeddingDimensions: 1536,
    inferenceModel: 'grok-2',
    fastModel: 'grok-2',
    envKey: 'XAI_API_KEY',
  },
};

export function createAIProvider(config: TraceMcpConfig): AIProvider {
  if (!config.ai?.enabled) {
    return new FallbackProvider();
  }

  const provider = config.ai.provider;

  if (provider === 'onnx') {
    return new OnnxProvider({
      model: config.ai.embedding_model,
      dimensions: config.ai.embedding_dimensions,
    });
  }

  if (provider === 'ollama') {
    return new OllamaProvider({
      baseUrl: config.ai.base_url ?? 'http://localhost:11434',
      embeddingModel: config.ai.embedding_model ?? 'qwen3-embedding:0.6b',
      inferenceModel: config.ai.inference_model ?? 'gemma4-e4b',
      fastModel: config.ai.fast_model ?? 'gemma4-e4b',
      embeddingDimensions: config.ai.embedding_dimensions,
    });
  }

  if (provider === 'gemini') {
    const apiKey = config.ai.api_key ?? process.env.GEMINI_API_KEY ?? '';
    if (!apiKey) {
      logger.warn('Gemini provider selected but no api_key configured — falling back');
      return new FallbackProvider();
    }
    return new GeminiProvider({
      apiKey,
      embeddingModel: config.ai.embedding_model ?? 'text-embedding-004',
      embeddingDimensions: config.ai.embedding_dimensions ?? 768,
      inferenceModel: config.ai.inference_model ?? 'gemini-2.0-flash',
      fastModel: config.ai.fast_model ?? 'gemini-2.0-flash',
    });
  }

  if (provider === 'anthropic') {
    const apiKey = config.ai.api_key ?? process.env.ANTHROPIC_API_KEY ?? '';
    if (!apiKey) {
      logger.warn('Anthropic provider selected but no api_key configured — falling back');
      return new FallbackProvider();
    }
    return new AnthropicProvider({
      apiKey,
      inferenceModel: config.ai.inference_model ?? 'claude-sonnet-4-20250514',
      fastModel: config.ai.fast_model ?? 'claude-haiku-4-5-20251001',
    });
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
    return new OpenAIProvider({
      apiKey,
      baseUrl: config.ai.base_url ?? defaults.baseUrl,
      embeddingModel: config.ai.embedding_model ?? defaults.embeddingModel,
      embeddingDimensions: config.ai.embedding_dimensions ?? defaults.embeddingDimensions,
      inferenceModel: config.ai.inference_model ?? defaults.inferenceModel,
      fastModel: config.ai.fast_model ?? defaults.fastModel,
    });
  }

  return new FallbackProvider();
}

export type { AIProvider, ChatMessage, EmbeddingService, InferenceService, VectorStore, RerankerService } from './interfaces.js';
export { FallbackProvider } from './fallback.js';
export { OllamaProvider } from './ollama.js';
export { OpenAIProvider } from './openai.js';
export { OnnxProvider, isOnnxAvailable } from './onnx.js';
export { GeminiProvider } from './gemini.js';
export { AnthropicProvider } from './anthropic.js';
export { BlobVectorStore } from './vector-store.js';
export { hybridSearch } from './search.js';
export { EmbeddingPipeline } from './embedding-pipeline.js';
export { InferenceCache } from './inference-cache.js';
export { CachedInferenceService } from './cached-inference.js';
export { SummarizationPipeline } from './summarization-pipeline.js';
export { PROMPTS } from './prompts.js';
export { LLMReranker } from './reranker.js';
export { parseOpenAIStream, parseAnthropicStream, parseOllamaChatStream } from './sse.js';
export { resolveProvider, gatherContext, buildSystemPrompt, stripContextFromMessage } from './ask-shared.js';
export type { LLMProvider } from './ask-shared.js';
export type { PromptTemplate } from './prompts.js';
