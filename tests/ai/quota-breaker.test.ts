import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetQuotaBreakerForTests,
  getQuotaBreaker,
  QuotaBreaker,
} from '../../src/ai/quota-breaker.js';

describe('QuotaBreaker', () => {
  let now = 1_000_000;
  let breaker: QuotaBreaker;

  beforeEach(() => {
    now = 1_000_000;
    breaker = new QuotaBreaker({ now: () => now });
  });

  it('starts closed for every provider', () => {
    expect(breaker.isOpen('anthropic')).toBe(false);
    expect(breaker.isOpen('openai')).toBe(false);
    expect(breaker.status('anthropic')).toBeNull();
  });

  it('trips on quota_exhausted with a 1h default cooldown', () => {
    breaker.trip('anthropic', 'quota_exhausted', { note: 'credit_balance_too_low' });
    expect(breaker.isOpen('anthropic')).toBe(true);
    const status = breaker.status('anthropic');
    expect(status?.kind).toBe('quota_exhausted');
    expect(status?.note).toBe('credit_balance_too_low');
    // 1 hour ahead.
    expect(status?.openUntilMs).toBe(now + 60 * 60 * 1000);
  });

  it('trips on auth_invalid with a 24h cooldown', () => {
    breaker.trip('openai', 'auth_invalid');
    const status = breaker.status('openai');
    expect(status?.openUntilMs).toBe(now + 24 * 60 * 60 * 1000);
  });

  it('does not trip on rate_limit, transient, unrecoverable, unknown', () => {
    for (const kind of ['rate_limit', 'transient', 'unrecoverable', 'unknown'] as const) {
      breaker.trip('voyage', kind);
      expect(breaker.isOpen('voyage')).toBe(false);
    }
  });

  it('respects a custom untilMs override', () => {
    const future = now + 30_000;
    breaker.trip('voyage', 'quota_exhausted', { untilMs: future });
    const status = breaker.status('voyage');
    expect(status?.openUntilMs).toBe(future);
  });

  it('auto-clears once the cooldown elapses', () => {
    breaker.trip('a', 'quota_exhausted');
    expect(breaker.isOpen('a')).toBe(true);
    now += 60 * 60 * 1000 + 1;
    expect(breaker.isOpen('a')).toBe(false);
    expect(breaker.status('a')).toBeNull();
  });

  it('reset() clears the breaker manually', () => {
    breaker.trip('a', 'quota_exhausted');
    breaker.reset('a');
    expect(breaker.isOpen('a')).toBe(false);
  });

  it('allOpen() returns all currently-open entries', () => {
    breaker.trip('a', 'quota_exhausted');
    breaker.trip('b', 'auth_invalid');
    const open = breaker.allOpen();
    expect(open.map((e) => e.provider).sort()).toEqual(['a', 'b']);
  });

  it('allOpen() drops entries whose cooldown elapsed', () => {
    breaker.trip('expired', 'quota_exhausted', { untilMs: now - 1 });
    breaker.trip('live', 'auth_invalid');
    expect(breaker.allOpen().map((e) => e.provider)).toEqual(['live']);
  });

  it('shared singleton survives across calls in the same process', () => {
    __resetQuotaBreakerForTests();
    const a = getQuotaBreaker();
    const b = getQuotaBreaker();
    expect(a).toBe(b);
  });
});
