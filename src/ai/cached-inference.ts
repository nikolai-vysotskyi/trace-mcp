/**
 * Wraps an InferenceService with a content-addressable cache.
 * Used at index time (summarization pipeline) to avoid redundant LLM calls.
 */

import type { InferenceCache } from './inference-cache.js';
import type { InferenceService } from './interfaces.js';

export class CachedInferenceService implements InferenceService {
  constructor(
    private inner: InferenceService,
    private cache: InferenceCache,
    private model: string,
  ) {}

  async generate(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const cached = this.cache.get(this.model, prompt);
    if (cached !== null) return cached;

    const response = await this.inner.generate(prompt, options);
    if (response) {
      this.cache.set(this.model, prompt, response);
    }
    return response;
  }
}
