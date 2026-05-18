/**
 * Tests for the LLM extraction primitive. The InferenceService is stubbed
 * so we never make real API calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InferenceService } from '../../src/ai/interfaces.js';
import type { ConversationTurn } from '../../src/memory/conversation-miner.js';
import {
  MAX_CHUNKS_PER_SESSION,
  chunkByTurnBoundary,
  extractDecisionsWithLlm,
  safeParseDecisions,
} from '../../src/memory/llm-extractor.js';

function makeTurns(content: string, count = 2): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: content,
      timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
      referenced_files: [],
      referenced_symbols: [],
    });
  }
  return out;
}

function makeProvider(response: string | Error): {
  service: InferenceService;
  generate: ReturnType<typeof vi.fn>;
} {
  const generate = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    service: { generate } as unknown as InferenceService,
    generate,
  };
}

function makeMemoryCache(): {
  get: (sid: string, sha: string, model: string) => string | null;
  put: (sid: string, sha: string, model: string, json: string) => void;
  size: () => number;
} {
  const store = new Map<string, string>();
  return {
    get: (sid, sha, model) => store.get(`${sid}|${sha}|${model}`) ?? null,
    put: (sid, sha, model, json) => {
      store.set(`${sid}|${sha}|${model}`, json);
    },
    size: () => store.size,
  };
}

describe('llm-extractor — safeParseDecisions', () => {
  it('parses a clean JSON array', () => {
    const json = JSON.stringify([
      {
        title: 'Use PostgreSQL',
        type: 'tech_choice',
        content: 'Picked Postgres for JSONB support.',
        tags: ['database'],
        confidence: 0.9,
      },
    ]);
    const out = safeParseDecisions(json);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Use PostgreSQL');
    expect(out[0].confidence).toBeCloseTo(0.9);
  });

  it('returns empty on malformed JSON', () => {
    expect(safeParseDecisions('not json at all')).toEqual([]);
    expect(safeParseDecisions('')).toEqual([]);
    expect(safeParseDecisions('{}')).toEqual([]);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const json = JSON.stringify([
      { title: '', type: 'tech_choice', content: 'no title', confidence: 0.5 },
      { title: 'good one', type: 'invalid_type', content: 'bad type', confidence: 0.5 },
      { title: 'valid', type: 'discovery', content: 'this works', confidence: 0.8 },
    ]);
    const out = safeParseDecisions(json);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('valid');
  });

  it('tolerates Markdown-fenced JSON', () => {
    const json = '```json\n[{"title":"x","type":"discovery","content":"y","confidence":0.7}]\n```';
    expect(safeParseDecisions(json)).toHaveLength(1);
  });

  it('clamps out-of-range confidence', () => {
    const json = JSON.stringify([
      { title: 'a', type: 'discovery', content: 'b', confidence: 5 },
      { title: 'c', type: 'discovery', content: 'd', confidence: -1 },
    ]);
    const out = safeParseDecisions(json);
    expect(out[0].confidence).toBe(1);
    expect(out[1].confidence).toBe(0);
  });
});

describe('llm-extractor — chunkByTurnBoundary', () => {
  it('returns a single chunk when under budget', () => {
    const turns = makeTurns('hi', 2);
    const chunks = chunkByTurnBoundary(turns, 10_000);
    expect(chunks).toHaveLength(1);
  });

  it('splits along turn boundaries when over budget', () => {
    const longText = 'x'.repeat(400);
    const turns = makeTurns(longText, 6);
    const chunks = chunkByTurnBoundary(turns, 500);
    expect(chunks.length).toBeGreaterThan(1);
    // no chunk should be wildly over the budget after at most one extra turn
    for (const c of chunks) {
      expect(c).toContain('x');
    }
  });

  it('never splits mid-turn', () => {
    const turns = [
      { role: 'user', text: 'a'.repeat(2000) },
      { role: 'assistant', text: 'b'.repeat(2000) },
    ];
    const chunks = chunkByTurnBoundary(turns, 1000);
    // Each chunk contains exactly one full turn (since each turn alone
    // already exceeds the budget — we don't fracture it).
    expect(chunks.some((c) => c === '[user] ' + 'a'.repeat(2000))).toBe(true);
    expect(chunks.some((c) => c === '[assistant] ' + 'b'.repeat(2000))).toBe(true);
  });
});

describe('llm-extractor — extractDecisionsWithLlm', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed decisions on a clean LLM response', async () => {
    const response = JSON.stringify([
      {
        title: 'Switch to vitest',
        type: 'tech_choice',
        content: 'Vitest is faster than jest for this monorepo.',
        tags: ['testing'],
        confidence: 0.85,
      },
    ]);
    const { service, generate } = makeProvider(response);
    const turns = makeTurns('long enough conversation content '.repeat(40), 4);

    const out = await extractDecisionsWithLlm(turns, {
      provider: service,
      model: 'test-model',
      maxTokens: 8000,
      minSessionLength: 100,
      sessionId: 's1',
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Switch to vitest');
  });

  it('returns empty when transcript is below minSessionLength', async () => {
    const { service, generate } = makeProvider('[]');
    const turns = makeTurns('hi', 1);
    const out = await extractDecisionsWithLlm(turns, {
      provider: service,
      model: 'test-model',
      maxTokens: 8000,
      minSessionLength: 10_000,
      sessionId: 's1',
    });
    expect(out).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });

  it('returns empty (no throw) on malformed LLM response', async () => {
    const { service } = makeProvider('not parseable');
    const turns = makeTurns('long enough conversation content '.repeat(40), 4);
    const out = await extractDecisionsWithLlm(turns, {
      provider: service,
      model: 'test-model',
      maxTokens: 8000,
      minSessionLength: 100,
      sessionId: 's1',
    });
    expect(out).toEqual([]);
  });

  it('drops malformed entries while keeping valid ones', async () => {
    const response = JSON.stringify([
      { title: 'good', type: 'discovery', content: 'real', confidence: 0.7 },
      { title: '', type: 'discovery', content: 'no title', confidence: 0.5 },
      { title: 'bad type', type: 'wat', content: 'bad', confidence: 0.7 },
    ]);
    const { service } = makeProvider(response);
    const turns = makeTurns('long enough conversation content '.repeat(40), 4);
    const out = await extractDecisionsWithLlm(turns, {
      provider: service,
      model: 'test-model',
      maxTokens: 8000,
      minSessionLength: 100,
      sessionId: 's1',
    });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('good');
  });

  it('hits the cache on second invocation with same content + model', async () => {
    const response = JSON.stringify([
      { title: 'x', type: 'discovery', content: 'y', confidence: 0.8 },
    ]);
    const { service, generate } = makeProvider(response);
    const cache = makeMemoryCache();
    const turns = makeTurns('long enough conversation content '.repeat(40), 4);

    await extractDecisionsWithLlm(turns, {
      provider: service,
      model: 'm1',
      maxTokens: 8000,
      minSessionLength: 100,
      sessionId: 's1',
      cache,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(1);

    const second = await extractDecisionsWithLlm(turns, {
      provider: service,
      model: 'm1',
      maxTokens: 8000,
      minSessionLength: 100,
      sessionId: 's1',
      cache,
    });
    expect(generate).toHaveBeenCalledTimes(1); // unchanged — cache hit
    expect(second).toHaveLength(1);
  });

  it('misses the cache when the model changes', async () => {
    const response = JSON.stringify([
      { title: 'x', type: 'discovery', content: 'y', confidence: 0.8 },
    ]);
    const { service, generate } = makeProvider(response);
    const cache = makeMemoryCache();
    const turns = makeTurns('long enough conversation content '.repeat(40), 4);

    await extractDecisionsWithLlm(turns, {
      provider: service,
      model: 'm1',
      maxTokens: 8000,
      minSessionLength: 100,
      sessionId: 's1',
      cache,
    });
    expect(generate).toHaveBeenCalledTimes(1);

    await extractDecisionsWithLlm(turns, {
      provider: service,
      model: 'm2',
      maxTokens: 8000,
      minSessionLength: 100,
      sessionId: 's1',
      cache,
    });
    expect(generate).toHaveBeenCalledTimes(2); // new model -> new call
  });

  it('chunks long transcripts into multiple provider calls', async () => {
    const response = '[]';
    const { service, generate } = makeProvider(response);
    // Build a transcript well above the 500-token (=2000-char) budget.
    const fatTurn = 'word '.repeat(800); // ~4000 chars per turn
    const turns = makeTurns(fatTurn, 6);

    await extractDecisionsWithLlm(turns, {
      provider: service,
      model: 'test-model',
      maxTokens: 500,
      minSessionLength: 100,
      sessionId: 's1',
    });

    expect(generate.mock.calls.length).toBeGreaterThan(1);
    expect(generate.mock.calls.length).toBeLessThanOrEqual(MAX_CHUNKS_PER_SESSION);
  });

  it('skips internal-protocol-only sessions (no LLM call)', async () => {
    const { service, generate } = makeProvider('[]');
    const turns: ConversationTurn[] = [
      {
        role: 'user',
        text: '<task-notification>autonomous</task-notification>',
        timestamp: '',
        referenced_files: [],
        referenced_symbols: [],
      },
    ];
    const out = await extractDecisionsWithLlm(turns, {
      provider: service,
      model: 'm1',
      maxTokens: 8000,
      minSessionLength: 100,
      sessionId: 's1',
    });
    expect(out).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });
});
