/**
 * Tests for the edge-confidence numeric layer that sits on top of the
 * categorical resolution_tier column.
 *
 * Two contracts the rest of the codebase relies on:
 *   1. Tier order is preserved by the numeric score —
 *      lsp_resolved > ast_resolved > ast_inferred > text_matched.
 *      Ranking code that filters by `confidence >= 0.7` should pick up
 *      ast_resolved + lsp_resolved but not the heuristic tiers.
 *   2. normalizeConfidence is robust to garbage from plugin code paths —
 *      NaN, Infinity, negatives, > 1.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE_BY_TIER,
  confidenceForTier,
  normalizeConfidence,
} from '../../src/db/confidence.js';

describe('confidenceForTier', () => {
  it('maps each known tier to the documented score', () => {
    expect(confidenceForTier('lsp_resolved')).toBe(1.0);
    expect(confidenceForTier('ast_resolved')).toBe(0.95);
    expect(confidenceForTier('ast_inferred')).toBe(0.7);
    expect(confidenceForTier('text_matched')).toBe(0.4);
  });

  it('preserves tier order', () => {
    expect(CONFIDENCE_BY_TIER.lsp_resolved).toBeGreaterThan(CONFIDENCE_BY_TIER.ast_resolved);
    expect(CONFIDENCE_BY_TIER.ast_resolved).toBeGreaterThan(CONFIDENCE_BY_TIER.ast_inferred);
    expect(CONFIDENCE_BY_TIER.ast_inferred).toBeGreaterThan(CONFIDENCE_BY_TIER.text_matched);
  });

  it('falls back to ast_resolved for unknown / undefined / null tiers', () => {
    expect(confidenceForTier(undefined)).toBe(0.95);
    expect(confidenceForTier(null)).toBe(0.95);
    expect(confidenceForTier('something_new')).toBe(0.95);
  });
});

describe('normalizeConfidence', () => {
  it('passes through valid scores in [0, 1]', () => {
    expect(normalizeConfidence(0, 'ast_resolved')).toBe(0);
    expect(normalizeConfidence(0.5, 'ast_resolved')).toBe(0.5);
    expect(normalizeConfidence(1, 'ast_resolved')).toBe(1);
  });

  it('clamps out-of-range values', () => {
    expect(normalizeConfidence(-0.3, 'ast_resolved')).toBe(0);
    expect(normalizeConfidence(1.5, 'ast_resolved')).toBe(1);
  });

  it('falls back to the tier default for NaN / Infinity / undefined', () => {
    expect(normalizeConfidence(undefined, 'lsp_resolved')).toBe(1.0);
    expect(normalizeConfidence(Number.NaN, 'ast_inferred')).toBe(0.7);
    expect(normalizeConfidence(Infinity, 'text_matched')).toBe(0.4);
  });
});
