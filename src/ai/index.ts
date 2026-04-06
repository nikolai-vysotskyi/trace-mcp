/**
 * AI layer factory — creates the appropriate provider based on config.
 * Returns FallbackProvider when AI is disabled.
 */
import type { TraceMcpConfig } from '../config.js';
import type { AIProvider } from './interfaces.js';
import { FallbackProvider } from './fallback.js';
import { OllamaProvider } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import { logger } from '../logger.js';

export function createAIProvider(config: TraceMcpConfig): AIProvider {
  if (!config.ai?.enabled) {
    return new FallbackProvider();
  }

  if (config.ai.provider === 'openai') {
    const apiKey = config.ai.api_key ?? process.env.OPENAI_API_KEY ?? '';
    if (!apiKey) {
      logger.warn('OpenAI provider selected but no api_key configured — falling back to FallbackProvider');
      return new FallbackProvider();
    }
    return new OpenAIProvider({
      apiKey,
      baseUrl: config.ai.base_url ?? 'https://api.openai.com/v1',
      embeddingModel: config.ai.embedding_model ?? 'text-embedding-3-small',
      embeddingDimensions: config.ai.embedding_dimensions ?? 1536,
      inferenceModel: config.ai.inference_model ?? 'gpt-4o-mini',
      fastModel: config.ai.fast_model ?? 'gpt-4o-mini',
    });
  }

  if (config.ai.provider === 'ollama') {
    return new OllamaProvider({
      baseUrl: config.ai.base_url ?? 'http://localhost:11434',
      embeddingModel: config.ai.embedding_model ?? 'qwen3-embedding:0.6b',
      inferenceModel: config.ai.inference_model ?? 'gemma4-e4b',
      fastModel: config.ai.fast_model ?? 'gemma4-e4b',
      embeddingDimensions: config.ai.embedding_dimensions,
    });
  }

  return new FallbackProvider();
}

export type { AIProvider, EmbeddingService, InferenceService, VectorStore, RerankerService } from './interfaces.js';
export { FallbackProvider } from './fallback.js';
export { OllamaProvider } from './ollama.js';
export { OpenAIProvider } from './openai.js';
export { BlobVectorStore } from './vector-store.js';
export { hybridSearch } from './search.js';
export { EmbeddingPipeline } from './embedding-pipeline.js';
export { InferenceCache } from './inference-cache.js';
export { CachedInferenceService } from './cached-inference.js';
export { SummarizationPipeline } from './summarization-pipeline.js';
export { PROMPTS } from './prompts.js';
export { LLMReranker } from './reranker.js';
export type { PromptTemplate } from './prompts.js';
