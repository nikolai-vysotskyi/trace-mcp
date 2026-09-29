import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceService } from '../../src/ai/interfaces.js';
import { PROMPTS } from '../../src/ai/prompts.js';
import {
  DEFAULT_RERANK_MAX_CANDIDATES,
  LLMReranker,
  resolveRerankMaxTokens,
} from '../../src/ai/reranker.js';
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

describe('LLMReranker — numbered scores + scaled budget (GH#1442)', () => {
  const docs3 = [
    { id: 1, text: 'First' },
    { id: 2, text: 'Second' },
    { id: 3, text: 'Third' },
  ];

  it('parses "N: score" output mapped by number', async () => {
    const reranker = new LLMReranker(createMockInference('1: 8\n2: 3\n3: 9'));
    const result = await reranker.rerank('query', docs3, 2);
    expect(result[0].id).toBe(3);
    expect(result[0].score).toBe(9);
    expect(result[1].id).toBe(1);
  });

  it('maps out-of-order numbers correctly (no positional shift)', async () => {
    const reranker = new LLMReranker(createMockInference('3: 9\n1: 8\n2: 3'));
    const result = await reranker.rerank('query', docs3, 3);
    expect(result.map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it('ignores stray numeric lines once numbering is present', async () => {
    const reranker = new LLMReranker(
      createMockInference('reasoning trace with 100\n1: 8\n2: 3\n3: 9'),
    );
    const result = await reranker.rerank('query', docs3, 3);
    expect(result.map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it('fills missing numbers with 0 instead of falling back', async () => {
    const reranker = new LLMReranker(createMockInference('1: 9\n3: 1'));
    const result = await reranker.rerank('query', docs3, 3);
    // Scores [9,0,1] → order 1, 3, 2 — the parsed scores are kept.
    expect(result.map((r) => r.id)).toEqual([1, 3, 2]);
    expect(result[2].score).toBe(0);
  });

  it('pads a short unnumbered response instead of discarding it', async () => {
    const reranker = new LLMReranker(createMockInference('8'));
    const result = await reranker.rerank('query', docs3, 3);
    expect(result[0].id).toBe(1);
    expect(result[0].score).toBe(8);
    expect(result).toHaveLength(3);
  });

  it('scales the token budget with candidate count', () => {
    expect(resolveRerankMaxTokens(200, 2)).toBe(200);
    expect(resolveRerankMaxTokens(200, 100)).toBe(100 * 6 + 32);
    expect(resolveRerankMaxTokens(200, 140)).toBe(140 * 6 + 32);
  });

  it('passes the scaled budget to the provider for 100+ candidates', async () => {
    const seen: (number | undefined)[] = [];
    const inference: InferenceService = {
      generate: vi.fn(async (_prompt: string, options) => {
        seen.push(options?.maxTokens);
        return Array.from({ length: 120 }, (_, i) => `${i + 1}: 5`).join('\n');
      }),
    };
    const reranker = new LLMReranker(inference, 200);
    const docs = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, text: `Doc ${i + 1}` }));
    // Cap at the default 100: 120 docs → 100 scored + tail fill to topK.
    const result = await reranker.rerank('query', docs, 120);
    expect(seen[0]).toBe(100 * 6 + 32);
    expect(result).toHaveLength(120);
  });

  it('caps candidates and fills the tail to preserve topK', async () => {
    const inference = createMockInference('1: 9\n2: 8\n3: 7\n4: 6\n5: 5');
    const reranker = new LLMReranker(inference, 200, 5);
    const docs = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, text: `Doc ${i + 1}` }));
    const result = await reranker.rerank('query', docs, 10);
    expect(result).toHaveLength(10);
    expect(result.slice(0, 5).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('defaults the candidate cap to 100', () => {
    expect(DEFAULT_RERANK_MAX_CANDIDATES).toBe(100);
  });
});
