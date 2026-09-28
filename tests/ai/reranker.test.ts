import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceService } from '../../src/ai/interfaces.js';
import { PROMPTS } from '../../src/ai/prompts.js';
import { LLMReranker } from '../../src/ai/reranker.js';
import { logger } from '../../src/logger.js';

function createMockInference(response: string): InferenceService {
  return {
    generate: vi.fn(async () => response),
  };
}

describe('LLMReranker', () => {
  it('reranks documents based on LLM scores', async () => {
    const inference = createMockInference('8\n3\n9');
    const reranker = new LLMReranker(inference);

    const docs = [
      { id: 1, text: 'User authentication' },
      { id: 2, text: 'Database migration' },
      { id: 3, text: 'Login handler' },
    ];

    const result = await reranker.rerank('login', docs, 2);
    expect(result).toHaveLength(2);
    // id=3 (score 9) should be first, then id=1 (score 8)
    expect(result[0].id).toBe(3);
    expect(result[0].score).toBe(9);
    expect(result[1].id).toBe(1);
    expect(result[1].score).toBe(8);
  });

  it('returns original order on parse failure', async () => {
    const inference = createMockInference('unparseable gibberish');
    const reranker = new LLMReranker(inference);

    const docs = [
      { id: 1, text: 'First' },
      { id: 2, text: 'Second' },
    ];

    const result = await reranker.rerank('query', docs, 2);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(2);
  });

  it('returns original order on inference error', async () => {
    const inference: InferenceService = {
      generate: vi.fn(async () => {
        throw new Error('network error');
      }),
    };
    const reranker = new LLMReranker(inference);

    const docs = [
      { id: 1, text: 'First' },
      { id: 2, text: 'Second' },
    ];

    const result = await reranker.rerank('query', docs, 2);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
  });

  it('handles empty documents', async () => {
    const inference = createMockInference('');
    const reranker = new LLMReranker(inference);

    const result = await reranker.rerank('query', [], 5);
    expect(result).toEqual([]);
  });

  it('handles single document', async () => {
    const inference = createMockInference('');
    const reranker = new LLMReranker(inference);

    const result = await reranker.rerank('query', [{ id: 1, text: 'Only one' }], 5);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
    // Should not call inference for a single document
    expect(inference.generate).not.toHaveBeenCalled();
  });
});

describe('LLMReranker — output budget (GH#1423)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  const docs = [
    { id: 1, text: 'First' },
    { id: 2, text: 'Second' },
  ];

  it('passes the configured maxTokens to the provider', async () => {
    const seen: (number | undefined)[] = [];
    const inference: InferenceService = {
      generate: vi.fn(async (_prompt: string, options) => {
        seen.push(options?.maxTokens);
        return '8\n3';
      }),
    };
    const reranker = new LLMReranker(inference, 1024);

    await reranker.rerank('query', docs, 2);
    expect(seen).toEqual([1024]);
  });

  it('defaults to the prompt template budget when maxTokens is unset', async () => {
    const seen: (number | undefined)[] = [];
    const inference: InferenceService = {
      generate: vi.fn(async (_prompt: string, options) => {
        seen.push(options?.maxTokens);
        return '8\n3';
      }),
    };
    const reranker = new LLMReranker(inference);

    await reranker.rerank('query', docs, 2);
    expect(seen).toEqual([PROMPTS.rerank.maxTokens]);
  });

  it('warns (not debug) when scores fail to parse — e.g. empty reasoning-model response', async () => {
    const inference = createMockInference('');
    const reranker = new LLMReranker(inference);

    const result = await reranker.rerank('query', docs, 2);
    // Still falls back to original order…
    expect(result.map((r) => r.id)).toEqual([1, 2]);
    // …but loudly: every search was paying full rerank latency for nothing.
    const messages = warnSpy.mock.calls.map((c) => JSON.stringify(c));
    const parseWarn = messages.find((m) => m.includes('failed to parse scores'));
    expect(parseWarn).toBeDefined();
    expect(parseWarn).toContain('ai.rerank_max_tokens');
  });

  it('throttles the parse-failure warn: loud a few times, then debug', async () => {
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined as never);
    try {
      const inference = createMockInference('');
      const reranker = new LLMReranker(inference);

      for (let i = 0; i < 5; i++) {
        await reranker.rerank('query', docs, 2);
      }
      expect(warnSpy).toHaveBeenCalledTimes(3);
      expect(debugSpy).toHaveBeenCalledTimes(2);
    } finally {
      debugSpy.mockRestore();
    }
  });
});
