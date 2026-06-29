import { describe, expect, it } from 'vitest';
import type { EmbeddingService, RerankerService } from '../../src/ai/interfaces.js';
import { hybridRankDecisions } from '../../src/memory/decision-hybrid.js';
import type { DecisionRow } from '../../src/memory/decision-types.js';

function dec(id: number, title: string, content = ''): DecisionRow {
  return {
    id,
    title,
    content,
    type: 'tech_choice',
    project_root: '/p',
    service_name: null,
    symbol_id: null,
    file_path: null,
    tags: null,
    valid_from: '2026-01-01T00:00:00.000Z',
    valid_until: null,
    session_id: null,
    source: 'manual',
    confidence: 1,
    git_branch: null,
    review_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: null,
    hit_count: 0,
    last_hit_at: null,
  };
}

/**
 * Deterministic bag-of-words embedding: vector over a fixed vocabulary, each
 * component = term frequency. Cosine similarity then mirrors lexical overlap,
 * which is enough to exercise the fusion + ordering logic without a real model.
 */
const VOCAB = ['cache', 'redis', 'auth', 'argon2', 'graphql', 'rest', 'node', 'lts'];
function bagEmbed(text: string): number[] {
  const lower = text.toLowerCase();
  return VOCAB.map((w) => (lower.match(new RegExp(w, 'g')) ?? []).length);
}

const fakeEmbeddings: EmbeddingService = {
  async embed(text) {
    return bagEmbed(text);
  },
  async embedBatch(texts) {
    return texts.map(bagEmbed);
  },
  dimensions() {
    return VOCAB.length;
  },
  modelName() {
    return 'fake-bow';
  },
};

describe('hybridRankDecisions', () => {
  it('returns the FTS5 pool order unchanged when no embedding service', async () => {
    const pool = [dec(1, 'A'), dec(2, 'B'), dec(3, 'C')];
    const out = await hybridRankDecisions({ query: 'anything', pool });
    expect(out.map((d) => d.id)).toEqual([1, 2, 3]);
  });

  it('returns the pool unchanged for a single-row pool', async () => {
    const pool = [dec(1, 'only')];
    const out = await hybridRankDecisions({
      query: 'redis',
      pool,
      embeddingService: fakeEmbeddings,
    });
    expect(out.map((d) => d.id)).toEqual([1]);
  });

  it('promotes the semantically-closest row above lexical-only noise', async () => {
    // FTS5 pool order puts the weak match first; embeddings should lift the
    // strong "redis cache" match up via the similarity channel.
    const pool = [
      dec(1, 'Node LTS policy', 'pin node to 20 lts'),
      dec(2, 'Cache layer', 'adopted redis redis cache for sessions'),
      dec(3, 'GraphQL gateway', 'rest vs graphql tradeoff'),
    ];
    const out = await hybridRankDecisions({
      query: 'redis cache',
      pool,
      embeddingService: fakeEmbeddings,
      weights: { lexical: 0.2, similarity: 0.8 },
    });
    expect(out[0].id).toBe(2);
  });

  it('honours the limit', async () => {
    const pool = [dec(1, 'a redis'), dec(2, 'b redis'), dec(3, 'c'), dec(4, 'd')];
    const out = await hybridRankDecisions({
      query: 'redis',
      pool,
      embeddingService: fakeEmbeddings,
      limit: 2,
    });
    expect(out).toHaveLength(2);
  });

  it('degrades to lexical order when embedding throws', async () => {
    const throwing: EmbeddingService = {
      async embed() {
        throw new Error('boom');
      },
      async embedBatch() {
        throw new Error('boom');
      },
      dimensions() {
        return 3;
      },
      modelName() {
        return 'broken';
      },
    };
    const pool = [dec(1, 'A'), dec(2, 'B')];
    const out = await hybridRankDecisions({
      query: 'redis',
      pool,
      embeddingService: throwing,
    });
    expect(out.map((d) => d.id)).toEqual([1, 2]);
  });

  it('applies a reranker pass over the fused top-N', async () => {
    const pool = [dec(1, 'redis a'), dec(2, 'redis b'), dec(3, 'redis c')];
    // Reranker that forces id 3 to the front regardless of fusion.
    const reranker: RerankerService = {
      async rerank(_q, docs) {
        return docs
          .map((d) => ({ id: d.id, score: d.id === 3 ? 1 : 0 }))
          .sort((a, b) => b.score - a.score);
      },
    };
    const out = await hybridRankDecisions({
      query: 'redis',
      pool,
      embeddingService: fakeEmbeddings,
      reranker,
    });
    expect(out[0].id).toBe(3);
  });
});
