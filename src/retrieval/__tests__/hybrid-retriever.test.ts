/**
 * Hybrid retriever — RRF correctness + null-AI fallback.
 */
import { describe, expect, it } from 'vitest';
import { runRetriever } from '../types.js';
import { fuseRrf, HybridRetriever } from '../retrievers/hybrid-retriever.js';
import type { BaseRetriever, RetrieverContext } from '../types.js';
import type { LexicalQuery, LexicalResult } from '../retrievers/lexical-retriever.js';
import type { SemanticQuery, SemanticResult } from '../retrievers/semantic-retriever.js';

/** A stub retriever that emits the rows it was given, sorted as provided. */
function stub<Q extends { text: string; limit?: number }, R extends { id: string; score: number }>(
  name: string,
  rowsFor: (text: string) => R[],
): BaseRetriever<Q, R> {
  return {
    name,
    async getContext(query: Q) {
      return { query, data: { text: query.text ?? '' } };
    },
    async getCompletion(ctx: RetrieverContext<unknown>): Promise<R[]> {
      const data = ctx.data as { text: string };
      return rowsFor(data.text);
    },
    async getAnswer(results: R[]): Promise<R[]> {
      return results;
    },
  };
}

function lex(id: string, score = 1): LexicalResult {
  return {
    id,
    score,
    source: 'fts',
    payload: {
      symbolId: 0,
      rank: -score,
      name: id,
      fqn: null,
      kind: 'function',
      fileId: 1,
      symbolIdStr: id,
    },
  };
}

function sem(id: string, score = 1): SemanticResult {
  return {
    id,
    score,
    source: 'embedding',
    payload: { symbolId: Number(id) || 0, score },
  };
}

describe('fuseRrf — math', () => {
  it('items in both channels rank above items in only one (k=60)', () => {
    // Lexical:  A, B, C
    // Semantic: B, D, A
    // RRF expected scores @k=60:
    //   A: 1/(60+1) + 1/(60+3) = 0.01639... + 0.01587... = 0.03226...
    //   B: 1/(60+2) + 1/(60+1) = 0.01612... + 0.01639... = 0.03251...
    //   C: 1/(60+3) = 0.01587...
    //   D: 1/(60+2) = 0.01612...
    // Top order: B > A > D > C
    const fused = fuseRrf([lex('A'), lex('B'), lex('C')], [sem('B'), sem('D'), sem('A')], 60);
    expect(fused.map((r) => r.id)).toEqual(['B', 'A', 'D', 'C']);
    // Both A and B should have channels populated.
    const a = fused.find((r) => r.id === 'A')!;
    expect(a.payload.channels.lexical).toBe(1);
    expect(a.payload.channels.semantic).toBe(3);
    const c = fused.find((r) => r.id === 'C')!;
    expect(c.payload.channels.semantic).toBeUndefined();
  });

  it('with an empty semantic channel, RRF preserves lexical ordering', () => {
    const fused = fuseRrf([lex('X'), lex('Y'), lex('Z')], [], 60);
    expect(fused.map((r) => r.id)).toEqual(['X', 'Y', 'Z']);
    expect(fused[0].payload.channels.semantic).toBeUndefined();
  });

  it('with an empty lexical channel, RRF preserves semantic ordering', () => {
    const fused = fuseRrf([], [sem('P'), sem('Q')], 60);
    expect(fused.map((r) => r.id)).toEqual(['P', 'Q']);
    expect(fused[0].payload.channels.lexical).toBeUndefined();
  });

  it('source on fused items is "hybrid"', () => {
    const fused = fuseRrf([lex('A')], [sem('B')], 60);
    for (const r of fused) expect(r.source).toBe('hybrid');
  });
});

describe('HybridRetriever — composition', () => {
  it('null semantic side degrades to lexical-only', async () => {
    const lexical = stub<LexicalQuery, LexicalResult>('lexical', () => [lex('L1'), lex('L2')]);
    const retriever = new HybridRetriever(lexical, null);
    const out = await runRetriever(retriever, { text: 'q' });
    expect(out.map((r) => r.id)).toEqual(['L1', 'L2']);
    expect(out.every((r) => r.payload.channels.semantic === undefined)).toBe(true);
  });

  it('with both channels wired, fusion runs', async () => {
    const lexical = stub<LexicalQuery, LexicalResult>('lexical', () => [lex('A'), lex('B')]);
    const semantic = stub<SemanticQuery, SemanticResult>('semantic', () => [sem('B'), sem('C')]);
    const retriever = new HybridRetriever(lexical, semantic);
    const out = await runRetriever(retriever, { text: 'q' });
    // B is in both channels → should be ranked first.
    expect(out[0].id).toBe('B');
    expect(out.map((r) => r.id).sort()).toEqual(['A', 'B', 'C']);
  });

  it('empty query → []', async () => {
    const lexical = stub<LexicalQuery, LexicalResult>('lexical', () => [lex('A')]);
    const retriever = new HybridRetriever(lexical, null);
    const out = await runRetriever(retriever, { text: '' });
    expect(out).toEqual([]);
  });

  it('exposes name "hybrid"', () => {
    const lexical = stub<LexicalQuery, LexicalResult>('lexical', () => []);
    expect(new HybridRetriever(lexical, null).name).toBe('hybrid');
  });
});
