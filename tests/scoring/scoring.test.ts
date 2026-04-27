import { describe, it, expect } from 'vitest';
import { hybridScore, getTypeBonus, computeRecency } from '../../src/scoring/hybrid.js';
import { assembleContext, type ContextItem } from '../../src/scoring/assembly.js';

describe('hybridScore', () => {
  it('returns weighted sum of inputs', () => {
    const score = hybridScore({
      relevance: 1.0,
      pagerank: 1.0,
      recency: 1.0,
      typeBonus: 1.0,
    });
    // 0.50 + 0.25 + 0.15 + 0.10 = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('returns 0 when all inputs are 0', () => {
    const score = hybridScore({
      relevance: 0,
      pagerank: 0,
      recency: 0,
      typeBonus: 0,
    });
    expect(score).toBe(0);
  });

  it('weights relevance highest', () => {
    const relOnly = hybridScore({ relevance: 1, pagerank: 0, recency: 0, typeBonus: 0 });
    const prOnly = hybridScore({ relevance: 0, pagerank: 1, recency: 0, typeBonus: 0 });
    expect(relOnly).toBeGreaterThan(prOnly);
  });

  it('produces correct partial score', () => {
    const score = hybridScore({
      relevance: 0.8,
      pagerank: 0.6,
      recency: 0.4,
      typeBonus: 0.2,
    });
    // 0.50*0.8 + 0.25*0.6 + 0.15*0.4 + 0.10*0.2 = 0.4 + 0.15 + 0.06 + 0.02 = 0.63
    expect(score).toBeCloseTo(0.63, 5);
  });
});

describe('getTypeBonus', () => {
  it('returns 1.0 for class', () => {
    expect(getTypeBonus('class')).toBe(1.0);
  });

  it('returns higher score for class than method', () => {
    expect(getTypeBonus('class')).toBeGreaterThan(getTypeBonus('method'));
  });

  it('returns default for unknown kind', () => {
    expect(getTypeBonus('unknown_kind')).toBe(0.1);
  });
});

describe('computeRecency', () => {
  it('returns 1.0 for just-now timestamp', () => {
    const now = new Date();
    const score = computeRecency(now.toISOString(), now);
    expect(score).toBeCloseTo(1.0, 1);
  });

  it('returns 0 for timestamp older than maxAgeDays', () => {
    const now = new Date('2026-04-01');
    const old = new Date('2026-02-01'); // ~59 days ago
    const score = computeRecency(old.toISOString(), now, 30);
    expect(score).toBe(0);
  });

  it('returns ~0.5 for timestamp halfway through window', () => {
    const now = new Date('2026-04-01');
    const mid = new Date('2026-03-17'); // 15 days ago
    const score = computeRecency(mid.toISOString(), now, 30);
    expect(score).toBeCloseTo(0.5, 1);
  });
});

describe('assembleContext', () => {
  const makeItem = (id: string, score: number, sourceLen: number): ContextItem => ({
    id,
    score,
    source: 'x'.repeat(sourceLen),
    signature: `function ${id}()`,
    metadata: `// ${id}`,
  });

  it('respects token budget', () => {
    const items = [makeItem('a', 1.0, 1000), makeItem('b', 0.5, 1000), makeItem('c', 0.3, 1000)];

    // Very small budget: should not fit all items at full detail
    const result = assembleContext(items, 50);
    expect(result.totalTokens).toBeLessThanOrEqual(50);
  });

  it('sorts items by score descending', () => {
    const items = [makeItem('low', 0.1, 10), makeItem('high', 0.9, 10), makeItem('mid', 0.5, 10)];

    const result = assembleContext(items, 10000);
    expect(result.items[0].id).toBe('high');
    expect(result.items[1].id).toBe('mid');
    expect(result.items[2].id).toBe('low');
  });

  it('degrades from full to no_source when budget is tight', () => {
    const items: ContextItem[] = [
      {
        id: 'big',
        score: 1.0,
        source: 'x'.repeat(2000),
        signature: 'function big()',
        metadata: '// big',
      },
    ];

    // Budget too small for full source but enough for signature
    const result = assembleContext(items, 20);
    if (result.items.length > 0) {
      expect(['no_source', 'signature_only']).toContain(result.items[0].detail);
    }
  });

  it('returns truncated=true when items are dropped', () => {
    // Items with very long signatures that won't fit in a tiny budget
    const items: ContextItem[] = [
      {
        id: 'a',
        score: 1.0,
        source: 'x'.repeat(5000),
        signature: 'y'.repeat(500),
        metadata: 'z'.repeat(500),
      },
      {
        id: 'b',
        score: 0.5,
        source: 'x'.repeat(5000),
        signature: 'y'.repeat(500),
        metadata: 'z'.repeat(500),
      },
    ];

    // Budget of 1 token is too small for anything
    const result = assembleContext(items, 1);
    expect(result.truncated).toBe(true);
    expect(result.items).toHaveLength(0);
  });

  it('handles empty input', () => {
    const result = assembleContext([], 1000);
    expect(result.items).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.truncated).toBe(false);
  });
});
