/**
 * Protocol-level tests: registry behaviour and `runRetriever` pipeline.
 *
 * These tests use a stub retriever — they assert the protocol shape, not
 * the lexical/semantic adapters (those have their own files).
 */
import { describe, expect, it } from 'vitest';
import { createRetrieverRegistry, InMemoryRetrieverRegistry } from '../registry.js';
import type { BaseRetriever, RetrievedItem, RetrieverContext } from '../types.js';
import { runRetriever } from '../types.js';

/** A trivial retriever — produces one result per query word, scored by index. */
class WordRetriever implements BaseRetriever<string, RetrievedItem<string>> {
  readonly name: string;
  constructor(name = 'word') {
    this.name = name;
  }
  async getContext(query: string): Promise<RetrieverContext<string[]>> {
    return { query, data: query.split(/\s+/).filter(Boolean) };
  }
  async getCompletion(context: RetrieverContext<unknown>): Promise<RetrievedItem<string>[]> {
    const words = context.data as string[];
    return words.map((word, idx) => ({
      id: word,
      score: words.length - idx,
      source: 'stub',
      payload: word,
    }));
  }
  async getAnswer(results: RetrievedItem<string>[]): Promise<RetrievedItem<string>[]> {
    // Dedupe by id, keep highest score.
    const best = new Map<string, RetrievedItem<string>>();
    for (const r of results) {
      const prev = best.get(r.id);
      if (!prev || r.score > prev.score) best.set(r.id, r);
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }
}

describe('RetrieverRegistry', () => {
  it('registers, retrieves, and lists retrievers', () => {
    const registry = createRetrieverRegistry();
    expect(registry.list()).toEqual([]);

    const a = new WordRetriever('alpha');
    const b = new WordRetriever('beta');
    registry.register(a);
    registry.register(b);

    expect(registry.list()).toEqual(['alpha', 'beta']);
    expect(registry.get('alpha')).toBe(a);
    expect(registry.get('beta')).toBe(b);
  });

  it('returns undefined for unknown names', () => {
    const registry = createRetrieverRegistry();
    expect(registry.get('nope')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const registry = createRetrieverRegistry();
    registry.register(new WordRetriever('dupe'));
    expect(() => registry.register(new WordRetriever('dupe'))).toThrow(/already registered/);
  });

  it('rejects retrievers with an empty name', () => {
    const registry = new InMemoryRetrieverRegistry();
    const bad: BaseRetriever = {
      name: '',
      async getContext(q) {
        return { query: q, data: null };
      },
      async getCompletion() {
        return [];
      },
      async getAnswer(results) {
        return results;
      },
    };
    expect(() => registry.register(bad)).toThrow(/non-empty/);
  });

  it('list() returns names sorted', () => {
    const registry = createRetrieverRegistry();
    registry.register(new WordRetriever('zulu'));
    registry.register(new WordRetriever('alpha'));
    registry.register(new WordRetriever('mike'));
    expect(registry.list()).toEqual(['alpha', 'mike', 'zulu']);
  });
});

describe('runRetriever pipeline', () => {
  it('chains getContext → getCompletion → getAnswer', async () => {
    const retriever = new WordRetriever();
    const out = await runRetriever(retriever, 'foo bar baz');
    expect(out.map((r) => r.id)).toEqual(['foo', 'bar', 'baz']);
    expect(out.every((r) => r.source === 'stub')).toBe(true);
  });

  it('dedupes through getAnswer', async () => {
    const retriever = new WordRetriever();
    // "foo" appears twice — getAnswer dedupes, keeping the higher score.
    const out = await runRetriever(retriever, 'foo bar foo');
    expect(out.map((r) => r.id).sort()).toEqual(['bar', 'foo']);
  });

  it('handles empty queries without throwing', async () => {
    const retriever = new WordRetriever();
    const out = await runRetriever(retriever, '');
    expect(out).toEqual([]);
  });
});
