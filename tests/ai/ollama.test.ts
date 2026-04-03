import { describe, it, expect } from 'vitest';
import { OllamaProvider } from '../../src/ai/ollama.js';
import { createAIProvider } from '../../src/ai/index.js';
import { FallbackProvider } from '../../src/ai/fallback.js';
import type { TraceMcpConfig } from '../../src/config.js';

describe('OllamaProvider', () => {
  it('constructs with config', () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
      inferenceModel: 'llama3.2',
      fastModel: 'llama3.2',
    });
    expect(provider).toBeDefined();
  });

  it('isAvailable() returns false when no server running', async () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:19999', // unlikely to be running
      embeddingModel: 'test',
      inferenceModel: 'test',
      fastModel: 'test',
    });
    const available = await provider.isAvailable();
    expect(available).toBe(false);
  });

  it('embedding() returns an EmbeddingService with correct dimensions', () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embeddingModel: 'test',
      inferenceModel: 'test',
      fastModel: 'test',
      embeddingDimensions: 1024,
    });
    expect(provider.embedding().dimensions()).toBe(1024);
  });

  it('defaults embedding dimensions to 768', () => {
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      embeddingModel: 'test',
      inferenceModel: 'test',
      fastModel: 'test',
    });
    expect(provider.embedding().dimensions()).toBe(768);
  });
});

describe('createAIProvider', () => {
  const baseConfig: TraceMcpConfig = {
    root: '.',
    include: [],
    exclude: [],
    db: { path: ':memory:' },
    plugins: [],
  };

  it('returns FallbackProvider when ai not configured', () => {
    const provider = createAIProvider(baseConfig);
    expect(provider).toBeInstanceOf(FallbackProvider);
  });

  it('returns FallbackProvider when ai.enabled is false', () => {
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: false, provider: 'ollama' },
    });
    expect(provider).toBeInstanceOf(FallbackProvider);
  });

  it('returns OllamaProvider when ai.enabled and provider is ollama', () => {
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'ollama' },
    });
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it('returns FallbackProvider for unknown provider', () => {
    const provider = createAIProvider({
      ...baseConfig,
      ai: { enabled: true, provider: 'unknown-provider' },
    });
    expect(provider).toBeInstanceOf(FallbackProvider);
  });
});
