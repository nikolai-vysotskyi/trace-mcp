import { describe, it, expect } from 'vitest';
import { computeAdaptiveBudget } from '../../src/scoring/adaptive-budget.js';

describe('Adaptive Token Budget', () => {
  it('returns full budget for early session', () => {
    const result = computeAdaptiveBudget('get_task_context', {
      totalCalls: 5,
      totalRawTokens: 10_000,
    });
    expect(result.budget).toBe(8000);
    expect(result.reduced).toBe(false);
  });

  it('reduces to 75% at mid session (50K–100K tokens)', () => {
    const result = computeAdaptiveBudget('get_task_context', {
      totalCalls: 20,
      totalRawTokens: 75_000,
    });
    expect(result.budget).toBe(6000); // 8000 * 0.75
    expect(result.reduced).toBe(true);
    expect(result.reason).toContain('75%');
  });

  it('reduces to 50% at high usage (100K–200K tokens)', () => {
    const result = computeAdaptiveBudget('get_task_context', {
      totalCalls: 40,
      totalRawTokens: 150_000,
    });
    expect(result.budget).toBe(4000); // 8000 * 0.5
    expect(result.reduced).toBe(true);
  });

  it('uses minimum budget at critical usage (200K+ tokens)', () => {
    const result = computeAdaptiveBudget('get_task_context', {
      totalCalls: 60,
      totalRawTokens: 250_000,
    });
    expect(result.budget).toBe(2000); // min budget
    expect(result.reduced).toBe(true);
  });

  it('respects user-specified budget', () => {
    const result = computeAdaptiveBudget('get_task_context', {
      totalCalls: 60,
      totalRawTokens: 250_000,
    }, 15000);
    expect(result.budget).toBe(15000);
    expect(result.reduced).toBe(false);
    expect(result.reason).toContain('User-specified');
  });

  it('uses correct defaults for get_feature_context', () => {
    const early = computeAdaptiveBudget('get_feature_context', {
      totalCalls: 3,
      totalRawTokens: 5_000,
    });
    expect(early.budget).toBe(4000); // default for get_feature_context

    const mid = computeAdaptiveBudget('get_feature_context', {
      totalCalls: 25,
      totalRawTokens: 80_000,
    });
    expect(mid.budget).toBe(3000); // 4000 * 0.75
  });

  it('never goes below minimum budget', () => {
    const result = computeAdaptiveBudget('get_feature_context', {
      totalCalls: 100,
      totalRawTokens: 500_000,
    });
    expect(result.budget).toBe(1000); // min for get_feature_context
    expect(result.budget).toBeGreaterThan(0);
  });

  it('handles unknown tool names with defaults', () => {
    const result = computeAdaptiveBudget('unknown_tool', {
      totalCalls: 5,
      totalRawTokens: 10_000,
    });
    expect(result.budget).toBe(8000); // fallback default
  });
});
