import { describe, expect, it } from 'vitest';
import { computeRetrievalConfidence } from '../../src/scoring/retrieval-confidence.js';

describe('computeRetrievalConfidence', () => {
  it('returns null when there are no scores', () => {
    expect(computeRetrievalConfidence({ scores: [] })).toBeNull();
  });

  it('flags an unambiguous identity match as high confidence', () => {
    const r = computeRetrievalConfidence({
      scores: [10, 1, 1],
      topName: 'getUser',
      query: 'getUser',
      freshnessSummary: { fresh: 3, edited_uncommitted: 0, stale_index: 0, repo_is_stale: false },
    });
    expect(r).not.toBeNull();
    expect(r!.level).toBe('high');
    expect(r!.signals.identity_match).toBe(1);
    expect(r!.signals.top_gap).toBeGreaterThan(0.5);
    expect(r!.confidence).toBeGreaterThan(0.7);
  });

  it('penalizes ambiguous results (small gap, no identity match)', () => {
    const r = computeRetrievalConfidence({
      scores: [5, 5, 5, 5],
      topName: 'somethingElse',
      query: 'getUser',
      freshness: ['fresh', 'fresh', 'fresh', 'fresh'],
    });
    expect(r).not.toBeNull();
    // top1=5/5=1 (full top1_strength), gap=0, identity=0, freshness=1
    // = 0.4*1 + 0.25*0 + 0.2*0 + 0.15*1 = 0.55 → medium
    expect(r!.level).toBe('medium');
    expect(r!.signals.top_gap).toBe(0);
    expect(r!.signals.identity_match).toBe(0);
  });

  it('drops confidence when results point at stale files', () => {
    const r = computeRetrievalConfidence({
      scores: [10, 1],
      topName: 'foo',
      query: 'foo',
      freshnessSummary: {
        fresh: 0,
        edited_uncommitted: 1,
        stale_index: 1,
        repo_is_stale: true,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.signals.freshness).toBe(0);
    // identity=1, top1=1, top_gap=0.9 → 0.4 + 0.225 + 0.2 + 0 = 0.825 still high
    // but freshness contribution is gone; verify it's lower than the all-fresh case.
    const fresh = computeRetrievalConfidence({
      scores: [10, 1],
      topName: 'foo',
      query: 'foo',
      freshnessSummary: { fresh: 2, edited_uncommitted: 0, stale_index: 0, repo_is_stale: false },
    });
    expect(fresh!.confidence).toBeGreaterThan(r!.confidence);
  });

  it('treats trailing-segment FQN matches as partial identity', () => {
    const r = computeRetrievalConfidence({
      scores: [1],
      topName: null,
      topFqn: 'pkg.sub.Foo',
      query: 'Foo',
      freshness: ['fresh'],
    });
    expect(r!.signals.identity_match).toBe(0.7);
  });

  it('does not crash with single-element score lists', () => {
    const r = computeRetrievalConfidence({
      scores: [1],
      topName: 'X',
      query: 'X',
      freshness: ['fresh'],
    });
    expect(r).not.toBeNull();
    expect(r!.signals.top_gap).toBe(1); // (1-0)/1
  });
});
