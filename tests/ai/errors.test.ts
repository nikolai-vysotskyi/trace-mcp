import { describe, expect, it, vi } from 'vitest';
import {
  ClassifiedProviderError,
  classifyProviderError,
  computeBackoff,
  withRetry,
} from '../../src/ai/errors.js';

describe('classifyProviderError', () => {
  it('classifies 429 as rate_limit', () => {
    const c = classifyProviderError('anthropic', { status: 429, message: 'Too Many Requests' });
    expect(c.kind).toBe('rate_limit');
    expect(c.status).toBe(429);
  });

  it('classifies "rate limit" message as rate_limit even without status', () => {
    const c = classifyProviderError('openai', new Error('You hit the rate limit'));
    expect(c.kind).toBe('rate_limit');
  });

  it('classifies quota exhaustion patterns as quota_exhausted', () => {
    const c1 = classifyProviderError('openai', {
      status: 429,
      message: 'You exceeded your current quota',
    });
    expect(c1.kind).toBe('quota_exhausted');

    const c2 = classifyProviderError('voyage', {
      status: 403,
      body: '{"error":"insufficient_credit"}',
    });
    expect(c2.kind).toBe('quota_exhausted');
  });

  it('classifies 401/403 (no quota body) as auth_invalid', () => {
    const c = classifyProviderError('anthropic', { status: 401, message: 'invalid API key' });
    expect(c.kind).toBe('auth_invalid');
  });

  it('classifies 5xx as transient', () => {
    expect(classifyProviderError('x', { status: 502 }).kind).toBe('transient');
    expect(classifyProviderError('x', { status: 503 }).kind).toBe('transient');
    expect(classifyProviderError('x', { status: 504 }).kind).toBe('transient');
  });

  it('classifies other 4xx as unrecoverable', () => {
    expect(classifyProviderError('x', { status: 400 }).kind).toBe('unrecoverable');
    expect(classifyProviderError('x', { status: 404 }).kind).toBe('unrecoverable');
    expect(classifyProviderError('x', { status: 422 }).kind).toBe('unrecoverable');
  });

  it('classifies node ECONNRESET as transient', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(classifyProviderError('x', err).kind).toBe('transient');
  });

  it('classifies AbortError as transient', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyProviderError('x', err).kind).toBe('transient');
  });

  it('classifies unknown shape as unknown', () => {
    expect(classifyProviderError('x', 'oops').kind).toBe('unknown');
  });

  it('parses Retry-After in seconds', () => {
    const c = classifyProviderError('x', {
      status: 429,
      headers: { 'retry-after': '5' },
    });
    expect(c.kind).toBe('rate_limit');
    expect(c.retryAfterMs).toBe(5_000);
  });

  it('parses Retry-After as HTTP date', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const c = classifyProviderError('x', {
      status: 429,
      headers: { 'retry-after': future },
    });
    expect(c.retryAfterMs).not.toBeNull();
    // Allow ~1s slack for time tracking variance.
    expect(c.retryAfterMs!).toBeGreaterThan(8_500);
    expect(c.retryAfterMs!).toBeLessThan(11_500);
  });

  it('captures x-request-id', () => {
    const c = classifyProviderError('x', {
      status: 500,
      headers: { 'x-request-id': 'req_abc123' },
    });
    expect(c.requestId).toBe('req_abc123');
  });

  it('passes through ClassifiedProviderError unchanged', () => {
    const original = new ClassifiedProviderError('a', 'rate_limit', 'msg');
    const out = classifyProviderError('b', original);
    expect(out).toBe(original);
  });
});

describe('computeBackoff', () => {
  it('honours retryAfterMs when set', () => {
    expect(
      computeBackoff({
        attempt: 1,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        jitter: 0,
        retryAfterMs: 7_000,
      }),
    ).toBe(7_000);
  });

  it('caps retryAfterMs at maxDelayMs', () => {
    expect(
      computeBackoff({
        attempt: 1,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        jitter: 0,
        retryAfterMs: 60_000,
      }),
    ).toBe(5_000);
  });

  it('exponential progression without jitter', () => {
    const opts = { baseDelayMs: 100, maxDelayMs: 10_000, jitter: 0, retryAfterMs: null };
    expect(computeBackoff({ ...opts, attempt: 1 })).toBe(100);
    expect(computeBackoff({ ...opts, attempt: 2 })).toBe(200);
    expect(computeBackoff({ ...opts, attempt: 3 })).toBe(400);
    expect(computeBackoff({ ...opts, attempt: 4 })).toBe(800);
  });

  it('caps exponential at maxDelayMs', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 3000, jitter: 0, retryAfterMs: null };
    expect(computeBackoff({ ...opts, attempt: 10 })).toBe(3000);
  });

  it('jitter stays within bounds', () => {
    for (let i = 0; i < 50; i++) {
      const v = computeBackoff({
        attempt: 3,
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        jitter: 0.3,
        retryAfterMs: null,
      });
      // attempt 3 = 400ms ±30% = [280, 520]
      expect(v).toBeGreaterThanOrEqual(280);
      expect(v).toBeLessThanOrEqual(520);
    }
  });
});

describe('withRetry', () => {
  it('returns the value on first success', async () => {
    const op = vi.fn(async () => 42);
    const v = await withRetry(op, { provider: 'x' });
    expect(v).toBe(42);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries on transient and eventually succeeds', async () => {
    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error('boom'), { status: 503 });
      return 'ok';
    });
    const v = await withRetry(op, {
      provider: 'x',
      baseDelayMs: 1,
      maxDelayMs: 5,
      jitter: 0,
    });
    expect(v).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('stops immediately on quota_exhausted', async () => {
    const op = vi.fn(async () => {
      throw { status: 429, message: 'You exceeded your current quota' };
    });
    await expect(
      withRetry(op, { provider: 'x', baseDelayMs: 1, maxDelayMs: 5 }),
    ).rejects.toMatchObject({ kind: 'quota_exhausted' });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('stops immediately on auth_invalid', async () => {
    const op = vi.fn(async () => {
      throw { status: 401, message: 'invalid api key' };
    });
    await expect(
      withRetry(op, { provider: 'x', baseDelayMs: 1, maxDelayMs: 5 }),
    ).rejects.toMatchObject({ kind: 'auth_invalid' });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('stops immediately on unrecoverable 4xx', async () => {
    const op = vi.fn(async () => {
      throw { status: 400, message: 'bad request' };
    });
    await expect(
      withRetry(op, { provider: 'x', baseDelayMs: 1, maxDelayMs: 5 }),
    ).rejects.toMatchObject({ kind: 'unrecoverable' });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('respects maxAttempts', async () => {
    const op = vi.fn(async () => {
      throw { status: 503 };
    });
    await expect(
      withRetry(op, { provider: 'x', maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 }),
    ).rejects.toMatchObject({ kind: 'transient' });
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('honours abort signal between retries', async () => {
    const ac = new AbortController();
    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        // Trigger abort on the way back from the first failure.
        ac.abort();
      }
      throw { status: 503 };
    });
    await expect(
      withRetry(op, {
        provider: 'x',
        maxAttempts: 5,
        baseDelayMs: 5,
        maxDelayMs: 10,
        signal: ac.signal,
      }),
    ).rejects.toThrow();
    // Either the sleep is interrupted by the abort, or the next attempt is.
    // Either way: not all 5 attempts run.
    expect(calls).toBeLessThanOrEqual(2);
  });
});
