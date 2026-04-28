import { describe, expect, it, vi } from 'vitest';
import type { InferenceService } from '../../src/ai/interfaces.js';
import { LLMReranker } from '../../src/ai/reranker.js';

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
