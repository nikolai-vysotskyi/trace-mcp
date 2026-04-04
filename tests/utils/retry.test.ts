import { describe, it, expect, vi } from 'vitest';
import { withRetry, isTransientError } from '../../src/utils/retry.js';

describe('retry utility', () => {
  describe('isTransientError', () => {
    it('detects AbortError as transient', () => {
      const err = new Error('timeout');
      err.name = 'AbortError';
      expect(isTransientError(err)).toBe(true);
    });

    it('detects TimeoutError as transient', () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      expect(isTransientError(err)).toBe(true);
    });

    it('detects network errors', () => {
      expect(isTransientError(new Error('fetch failed'))).toBe(true);
      expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
      expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
      expect(isTransientError(new Error('socket hang up'))).toBe(true);
    });

    it('detects HTTP 429/5xx in error messages', () => {
      expect(isTransientError(new Error('API failed: 429 Too Many Requests'))).toBe(true);
      expect(isTransientError(new Error('API failed: 500 Internal Server Error'))).toBe(true);
      expect(isTransientError(new Error('API failed: 502 Bad Gateway'))).toBe(true);
      expect(isTransientError(new Error('API failed: 503 Service Unavailable'))).toBe(true);
    });

    it('does not consider 400/401/404 as transient', () => {
      expect(isTransientError(new Error('API failed: 400 Bad Request'))).toBe(false);
      expect(isTransientError(new Error('API failed: 401 Unauthorized'))).toBe(false);
      expect(isTransientError(new Error('API failed: 404 Not Found'))).toBe(false);
    });

    it('does not consider non-Error values as transient', () => {
      expect(isTransientError('string error')).toBe(false);
      expect(isTransientError(null)).toBe(false);
      expect(isTransientError(42)).toBe(false);
    });
  });

  describe('withRetry', () => {
    it('returns result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await withRetry(fn, { maxAttempts: 3, label: 'test' });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on transient failure then succeeds', async () => {
      const err = new Error('fetch failed');
      const fn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValue('ok');

      const result = await withRetry(fn, {
        maxAttempts: 3,
        initialDelayMs: 10,
        label: 'test',
      });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting all attempts', async () => {
      const err = new Error('fetch failed');
      const fn = vi.fn().mockRejectedValue(err);

      await expect(
        withRetry(fn, { maxAttempts: 2, initialDelayMs: 10, label: 'test' }),
      ).rejects.toThrow('fetch failed');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('does not retry non-transient errors', async () => {
      const err = new Error('API failed: 401 Unauthorized');
      const fn = vi.fn().mockRejectedValue(err);

      await expect(
        withRetry(fn, { maxAttempts: 3, initialDelayMs: 10, label: 'test' }),
      ).rejects.toThrow('401 Unauthorized');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('respects custom isRetryable predicate', async () => {
      const err = new Error('custom error');
      const fn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValue('ok');

      const result = await withRetry(fn, {
        maxAttempts: 3,
        initialDelayMs: 10,
        isRetryable: () => true,
        label: 'test',
      });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('works with maxAttempts: 1 (no retry)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fetch failed'));
      await expect(
        withRetry(fn, { maxAttempts: 1, label: 'test' }),
      ).rejects.toThrow('fetch failed');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
