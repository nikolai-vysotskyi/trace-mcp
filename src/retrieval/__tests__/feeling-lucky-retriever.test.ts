/**
 * Feeling-Lucky retriever — verifies routing rules.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runRetriever } from '../types.js';
import type { BaseRetriever, RetrieverContext } from '../types.js';
import { classifyQuery, FeelingLuckyRetriever } from '../retrievers/feeling-lucky-retriever.js';
import type { LexicalQuery, LexicalResult } from '../retrievers/lexical-retriever.js';
import type { HybridQuery, HybridResult } from '../retrievers/hybrid-retriever.js';
import { setGlobalTelemetrySink } from '../../telemetry/index.js';
import type { Attributes, Span, TelemetrySink } from '../../telemetry/index.js';

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

/** Minimal sink that records every emit() for assertions. */
interface EmittedEvent {
  name: string;
  attrs: Attributes;
}

class RecordingSink implements TelemetrySink {
  readonly name = 'recording';
  events: EmittedEvent[] = [];
  startSpan(_name: string, _attributes?: Attributes): Span {
    // We never inspect spans in this test file — return a minimal noop.
    return {
      id: 'noop',
      name: 'noop',
      setAttribute() {},
      setAttributes() {},
      recordError() {},
      setStatus() {},
      end() {},
    };
  }
  emit(eventName: string, attributes?: Attributes): void {
    this.events.push({ name: eventName, attrs: { ...(attributes ?? {}) } });
  }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

class ThrowingSink implements TelemetrySink {
  readonly name = 'throwing';
  startSpan(): Span {
    throw new Error('span boom');
  }
  emit(): void {
    throw new Error('emit boom');
  }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

describe('FeelingLuckyRetriever — routing telemetry', () => {
  afterEach(() => {
    // Restore the global to noop between tests so we never bleed state.
    setGlobalTelemetrySink(null);
  });

  it('emits route=lexical, match_reason=camelcase for a camelCase query', async () => {
    const sink = new RecordingSink();
    const lexical = stubLexical([lexHit('authService')]);
    const hybrid = stubHybrid([]);
    const retriever = new FeelingLuckyRetriever(lexical, hybrid, sink);

    await runRetriever(retriever, { text: 'authService' });

    expect(sink.events.length).toBe(1);
    const ev = sink.events[0];
    expect(ev.name).toBe('retrieval.feeling_lucky.routed');
    expect(ev.attrs.route).toBe('lexical');
    expect(ev.attrs.match_reason).toBe('camelcase');
    expect(ev.attrs.query_length).toBe('authService'.length);
    expect(ev.attrs.query_token_count).toBe(1);
  });

  it('emits route=hybrid, match_reason=phrase_fallback for a multi-word query', async () => {
    const sink = new RecordingSink();
    const lexical = stubLexical([]);
    const hybrid = stubHybrid([hybHit('h')]);
    const retriever = new FeelingLuckyRetriever(lexical, hybrid, sink);

    const query = 'where does auth fail';
    await runRetriever(retriever, { text: query });

    expect(sink.events.length).toBe(1);
    expect(sink.events[0].name).toBe('retrieval.feeling_lucky.routed');
    expect(sink.events[0].attrs.route).toBe('hybrid');
    expect(sink.events[0].attrs.match_reason).toBe('phrase_fallback');
    expect(sink.events[0].attrs.query_length).toBe(query.length);
    expect(sink.events[0].attrs.query_token_count).toBe(4);
  });

  it('emits match_reason=snake_case / pascalcase / screaming / dotted_fqn for matching shapes', async () => {
    const sink = new RecordingSink();
    const lexical = stubLexical([lexHit('x')]);
    const hybrid = stubHybrid([]);
    const retriever = new FeelingLuckyRetriever(lexical, hybrid, sink);

    await runRetriever(retriever, { text: 'validate_input' });
    await runRetriever(retriever, { text: 'AuthService' });
    await runRetriever(retriever, { text: 'MAX_RETRIES' });
    await runRetriever(retriever, { text: 'Foo.bar.baz' });

    expect(sink.events.map((e) => e.attrs.match_reason)).toEqual([
      'snake_case',
      'pascalcase',
      'screaming',
      'dotted_fqn',
    ]);
    expect(sink.events.every((e) => e.attrs.route === 'lexical')).toBe(true);
  });

  it('does NOT emit when the query is empty', async () => {
    const sink = new RecordingSink();
    const lexical = stubLexical([]);
    const hybrid = stubHybrid([]);
    const retriever = new FeelingLuckyRetriever(lexical, hybrid, sink);

    await runRetriever(retriever, { text: '' });
    await runRetriever(retriever, { text: '   ' });

    expect(sink.events.length).toBe(0);
  });

  it('falls back to the global noop sink without throwing when no sink is injected', async () => {
    setGlobalTelemetrySink(null); // explicit: default noop
    const lexical = stubLexical([lexHit('AuthService')]);
    const hybrid = stubHybrid([]);
    const retriever = new FeelingLuckyRetriever(lexical, hybrid);

    const out = await runRetriever(retriever, { text: 'AuthService' });
    expect(out.length).toBe(1);
    expect(out[0].id).toBe('AuthService');
  });

  it('swallows sink errors and still returns retrieval results', async () => {
    const lexical = stubLexical([lexHit('AuthService')]);
    const hybrid = stubHybrid([]);
    const retriever = new FeelingLuckyRetriever(lexical, hybrid, new ThrowingSink());

    const out = await runRetriever(retriever, { text: 'AuthService' });
    expect(out.length).toBe(1);
    expect(out[0].payload.routedTo).toBe('lexical');
  });

  it('reads from the global sink when no override is passed to the constructor', async () => {
    const sink = new RecordingSink();
    setGlobalTelemetrySink(sink);

    const lexical = stubLexical([lexHit('AuthService')]);
    const hybrid = stubHybrid([]);
    const retriever = new FeelingLuckyRetriever(lexical, hybrid);

    await runRetriever(retriever, { text: 'AuthService' });
    expect(sink.events.length).toBe(1);
    expect(sink.events[0].attrs.route).toBe('lexical');
    expect(sink.events[0].attrs.match_reason).toBe('pascalcase');
  });
});
