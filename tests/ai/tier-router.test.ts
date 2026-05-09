import { describe, expect, it, vi } from 'vitest';
import type { AIProvider, InferenceService } from '../../src/ai/interfaces.js';
import { pickInferenceTier, pickInferenceTierName } from '../../src/ai/tier-router.js';

function makeProvider(): {
  provider: AIProvider;
  smart: InferenceService;
  fast: InferenceService;
} {
  const smart: InferenceService = { generate: vi.fn(async () => 'smart') };
  const fast: InferenceService = { generate: vi.fn(async () => 'fast') };
  const provider: AIProvider = {
    isAvailable: async () => true,
    embedding: () => ({
      embed: async () => [],
      embedBatch: async () => [],
      dimensions: () => 0,
      modelName: () => '',
    }),
    inference: () => smart,
    fastInference: () => fast,
  };
  return { provider, smart, fast };
}

describe('pickInferenceTierName', () => {
  it('returns "fast" for trivial / low complexity', () => {
    expect(pickInferenceTierName('trivial')).toBe('fast');
    expect(pickInferenceTierName('low')).toBe('fast');
  });

  it('returns "smart" for medium / high complexity', () => {
    expect(pickInferenceTierName('medium')).toBe('smart');
    expect(pickInferenceTierName('high')).toBe('smart');
  });

  it('defaults to "smart" when no hint is provided', () => {
    expect(pickInferenceTierName()).toBe('smart');
  });
});

describe('pickInferenceTier', () => {
  it('returns the fast service for trivial / low', () => {
    const { provider, fast } = makeProvider();
    expect(pickInferenceTier(provider, 'trivial')).toBe(fast);
    expect(pickInferenceTier(provider, 'low')).toBe(fast);
  });

  it('returns the smart service for medium / high', () => {
    const { provider, smart } = makeProvider();
    expect(pickInferenceTier(provider, 'medium')).toBe(smart);
    expect(pickInferenceTier(provider, 'high')).toBe(smart);
  });

  it('defaults to smart when no hint is provided', () => {
    const { provider, smart } = makeProvider();
    expect(pickInferenceTier(provider)).toBe(smart);
  });
});
