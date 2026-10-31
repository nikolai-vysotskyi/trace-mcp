/**
 * Wraps an InferenceService with a content-addressable cache.
 * Used at index time (summarization pipeline) to avoid redundant LLM calls.
 */

import type { InferenceCache } from './inference-cache.js';
import type { GenerateResult, InferenceService } from './interfaces.js';

export class CachedInferenceService implements InferenceService {
  constructor(
    private inner: InferenceService,
    private cache: InferenceCache,
    private model: string,
  ) {}

  get isFallback(): boolean {
    return (this.inner as { isFallback?: boolean })?.isFallback === true;
  }

  async generate(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<string> {
    const res = await this.generateDetailed(prompt, options);
    return res.text;
  }

  async generateDetailed(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<GenerateResult> {
    const cached = this.cache.get(this.model, prompt, options?.maxTokens);
    if (cached !== null) return { text: cached, finishReason: 'stop' };

    const res: GenerateResult = this.inner.generateDetailed
      ? await this.inner.generateDetailed(prompt, options)
      : { text: await this.inner.generate(prompt, options) };

    if (res.text) {
      this.cache.set(this.model, prompt, res.text, options?.maxTokens);
    }
    return res;
  }

  invalidate(prompt: string, maxTokens?: number): void {
    this.cache.delete(this.model, prompt, maxTokens);
  }
}
