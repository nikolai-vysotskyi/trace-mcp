/**
 * Semantic retriever tests — assert it returns SOMETHING with a working
 * embedding/vector pair, and `[]` with no AI provider. We do NOT gate
 * on vector quality — that's the responsibility of the underlying
 * VectorStore impl and is covered by its own tests.
 */
import { describe, expect, it } from 'vitest';
import type { EmbeddingService, VectorStore } from '../../ai/interfaces.js';
import { runRetriever } from '../types.js';
import { SemanticRetriever, createSemanticRetriever } from '../retrievers/semantic-retriever.js';

function makeEmbedding(): EmbeddingService {
  return {
    async embed() {
      return [0.1, 0.2, 0.3];
    },
    async embedBatch(texts: string[]) {
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
    dimensions() {
      return 3;
    },
    modelName() {
      return 'mock';
    },
  };
}

function makeVectorStore(rows: { id: number; score: number }[]): VectorStore {
  return {
    insert() {},
    search() {
      return rows;
    },
    delete() {},
    clear() {},
    setMeta() {},
    getMeta() {
      return { model: 'mock', dim: 3 };
    },
  };
}

describe('SemanticRetriever (adapter over VectorStore.search)', () => {
  it('returns results when an embedding service and vector store are wired in', async () => {
    const retriever = new SemanticRetriever(
      makeEmbedding(),
      makeVectorStore([
        { id: 10, score: 0.9 },
        { id: 11, score: 0.7 },
        { id: 12, score: 0.5 },
      ]),
    );
    const out = await runRetriever(retriever, { text: 'query', limit: 10 });
    expect(out.length).toBe(3);
    expect(out[0].id).toBe('10');
    expect(out[0].source).toBe('embedding');
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
  });

  it('returns empty when no AI provider is configured', async () => {
    const retriever = createSemanticRetriever(null, null);
    const out = await runRetriever(retriever, { text: 'whatever' });
    expect(out).toEqual([]);
  });

  it('returns empty when embedding is configured but vector store is not', async () => {
    const retriever = createSemanticRetriever(makeEmbedding(), null);
    const out = await runRetriever(retriever, { text: 'whatever' });
    expect(out).toEqual([]);
  });

  it('returns empty for empty query even when AI is wired in', async () => {
    const retriever = new SemanticRetriever(
      makeEmbedding(),
      makeVectorStore([{ id: 1, score: 1 }]),
    );
    const out = await runRetriever(retriever, { text: '' });
    expect(out).toEqual([]);
  });

  it('respects minScore threshold in getAnswer', async () => {
    const retriever = new SemanticRetriever(
      makeEmbedding(),
      makeVectorStore([
        { id: 1, score: 0.9 },
        { id: 2, score: 0.5 },
        { id: 3, score: 0.1 },
      ]),
    );
    const out = await runRetriever(retriever, { text: 'q', minScore: 0.4 });
    expect(out.map((r) => r.id)).toEqual(['1', '2']);
  });

  it('respects the limit knob', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, score: 1 - i * 0.05 }));
    const retriever = new SemanticRetriever(makeEmbedding(), makeVectorStore(rows));
    const out = await runRetriever(retriever, { text: 'q', limit: 3 });
    expect(out.length).toBe(3);
  });

  it('exposes name "semantic" for registry routing', () => {
    expect(new SemanticRetriever(null, null).name).toBe('semantic');
  });
});
