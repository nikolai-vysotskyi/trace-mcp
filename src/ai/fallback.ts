/**
 * No-op AI provider for when AI is disabled or unavailable.
 * All methods either return safe defaults or throw clear errors.
 */
import type { AIProvider, EmbeddingService, InferenceService } from './interfaces.js';

class FallbackEmbeddingService implements EmbeddingService {
  async embed(_text: string): Promise<number[]> {
    return [];
  }

  async embedBatch(_texts: string[]): Promise<number[][]> {
    return [];
  }

  dimensions(): number {
    return 0;
  }

  modelName(): string {
    return '';
  }
}

export class FallbackInferenceService implements InferenceService {
  async generate(_prompt: string): Promise<string> {
    return '';
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
