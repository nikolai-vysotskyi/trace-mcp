/**
 * Feeling-Lucky retriever — verifies routing rules.
 */
import { describe, expect, it } from 'vitest';
import { runRetriever } from '../types.js';
import type { BaseRetriever, RetrieverContext } from '../types.js';
import { classifyQuery, FeelingLuckyRetriever } from '../retrievers/feeling-lucky-retriever.js';
import type { LexicalQuery, LexicalResult } from '../retrievers/lexical-retriever.js';
import type { HybridQuery, HybridResult } from '../retrievers/hybrid-retriever.js';

function stubLexical(rows: LexicalResult[]): BaseRetriever<LexicalQuery, LexicalResult> {
  return {
    name: 'lexical',
    async getContext(query: LexicalQuery) {
      return { query, data: query };
    },
    async getCompletion(_ctx: RetrieverContext<unknown>) {
      return rows;
    },
    async getAnswer(r: LexicalResult[]) {
      return r;
    },
  };
}

function stubHybrid(rows: HybridResult[]): BaseRetriever<HybridQuery, HybridResult> {
  return {
    name: 'hybrid',
    async getContext(query: HybridQuery) {
      return { query, data: query };
    },
    async getCompletion(_ctx: RetrieverContext<unknown>) {
      return rows;
    },
    async getAnswer(r: HybridResult[]) {
      return r;
    },
  };
}

function lexHit(id: string): LexicalResult {
  return {
    id,
    score: 1,
    source: 'fts',
    payload: {
      symbolId: 0,
      rank: -1,
      name: id,
      fqn: null,
      kind: 'function',
      fileId: 1,
      symbolIdStr: id,
    },
  };
}

function hybHit(id: string): HybridResult {
  return {
    id,
    score: 1,
    source: 'hybrid',
    payload: { id, rrfScore: 1, channels: { lexical: 1 } },
  };
}

describe('classifyQuery — routing rules', () => {
  it('camelCase → lexical', () => {
    expect(classifyQuery('authService')).toBe('lexical');
  });
  it('PascalCase → lexical', () => {
    expect(classifyQuery('AuthService')).toBe('lexical');
  });
  it('snake_case → lexical', () => {
    expect(classifyQuery('validate_input')).toBe('lexical');
  });
  it('SCREAMING_SNAKE → lexical', () => {
    expect(classifyQuery('MAX_RETRIES')).toBe('lexical');
  });
  it('dotted FQN → lexical', () => {
    expect(classifyQuery('Foo.bar.baz')).toBe('lexical');
  });
  it('multi-word phrase → hybrid', () => {
    expect(classifyQuery('where does auth fail')).toBe('hybrid');
  });
  it('question with how → hybrid', () => {
    expect(classifyQuery('how to validate input')).toBe('hybrid');
  });
  it('phrase with punctuation → hybrid', () => {
    expect(classifyQuery('auth fails on retry?')).toBe('hybrid');
  });
  it('empty string → empty', () => {
    expect(classifyQuery('')).toBe('empty');
    expect(classifyQuery('   ')).toBe('empty');
  });
});

describe('FeelingLuckyRetriever — delegate selection', () => {
  it('symbol-shape query routes to lexical', async () => {
    const lexical = stubLexical([lexHit('AuthService')]);
    const hybrid = stubHybrid([hybHit('OTHER')]);
    const retriever = new FeelingLuckyRetriever(lexical, hybrid);

    const out = await runRetriever(retriever, { text: 'AuthService' });
    expect(out.length).toBe(1);
    expect(out[0].id).toBe('AuthService');
    expect(out[0].payload.routedTo).toBe('lexical');
    expect(out[0].source).toBe('feeling_lucky:lexical');
  });

  it('phrase query routes to hybrid', async () => {
    const lexical = stubLexical([lexHit('IRRELEVANT')]);
    const hybrid = stubHybrid([hybHit('found-via-hybrid')]);
    const retriever = new FeelingLuckyRetriever(lexical, hybrid);

    const out = await runRetriever(retriever, { text: 'where does auth fail' });
    expect(out.length).toBe(1);
    expect(out[0].id).toBe('found-via-hybrid');
    expect(out[0].payload.routedTo).toBe('hybrid');
    expect(out[0].source).toBe('feeling_lucky:hybrid');
  });

  it('empty query → []', async () => {
    const lexical = stubLexical([lexHit('X')]);
    const hybrid = stubHybrid([hybHit('Y')]);
    const retriever = new FeelingLuckyRetriever(lexical, hybrid);

    const out = await runRetriever(retriever, { text: '' });
    expect(out).toEqual([]);
  });

  it('exposes name "feeling_lucky"', () => {
    const lexical = stubLexical([]);
    const hybrid = stubHybrid([]);
    expect(new FeelingLuckyRetriever(lexical, hybrid).name).toBe('feeling_lucky');
  });
});
