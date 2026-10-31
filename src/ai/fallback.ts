/**
 * No-op AI provider for when AI is disabled or unavailable.
 * All methods either return safe defaults or throw clear errors.
 */
import type {
  AIProvider,
  EmbeddingService,
  EmbeddingTask,
  GenerateResult,
  InferenceService,
} from './interfaces.js';

class FallbackEmbeddingService implements EmbeddingService {
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
    return 'fallback';
  }
}

export class FallbackInferenceService implements InferenceService {
  readonly isFallback = true;

  async generate(
    _prompt: string,
    _options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<string> {
    return '';
  }

  async generateDetailed(
    _prompt: string,
    _options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<GenerateResult> {
    return { text: '', finishReason: 'unsupported' };
  }
}

export class FallbackProvider implements AIProvider {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  embedding(): EmbeddingService {
    return new FallbackEmbeddingService();
  }

  inference(): InferenceService {
    return new FallbackInferenceService();
  }

  fastInference(): InferenceService {
    return new FallbackInferenceService();
  }
}
