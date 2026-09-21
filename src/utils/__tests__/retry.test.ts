/**
 * TRA-1798: host-unreachable classification for embedding retries.
 *
 * When LM Studio / Ollama isn't running, undici surfaces the failure as
 * `TypeError: fetch failed` with the real code nested in
 * `cause: AggregateError [ECONNREFUSED]`. The classifier must see through
 * that wrapping; a bare "fetch failed" without code info stays retryable so
 * genuinely ambiguous failures keep the old (loud) path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger.js';
import {
  hostUnreachableCode,
  isHostUnreachableError,
  isRetryableEmbeddingError,
  isTransientError,
  withRetry,
} from '../retry.js';

/** Realistic undici shape for `fetch(http://localhost:1234/…)` with nothing listening. */
function refusedError(): TypeError {
  const conn = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), {
    code: 'ECONNREFUSED',
  });
  const aggregate = Object.assign(new AggregateError([conn], 'fetch failed'), {
    code: 'ECONNREFUSED',
  });
  return new TypeError('fetch failed', { cause: aggregate });
}

function dnsError(): TypeError {
  const conn = Object.assign(new Error('getaddrinfo ENOTFOUND ai.example'), {
    code: 'ENOTFOUND',
  });
  return new TypeError('fetch failed', { cause: conn });
}

describe('hostUnreachableCode', () => {
  it('sees ECONNREFUSED through the undici fetch-failed wrapping', () => {
    expect(hostUnreachableCode(refusedError())).toBe('ECONNREFUSED');
  });

  it('sees ENOTFOUND through a single-level cause', () => {
    expect(hostUnreachableCode(dnsError())).toBe('ENOTFOUND');
  });

  it('matches a bare code in the message', () => {
    expect(hostUnreachableCode(new Error('connect ECONNREFUSED 10.0.0.1:11434'))).toBe(
      'ECONNREFUSED',
    );
  });

  it('returns null for a bare "fetch failed" with no code info', () => {
    expect(hostUnreachableCode(new TypeError('fetch failed'))).toBeNull();
  });

  it('returns null for HTTP 500, timeouts and junk input', () => {
    expect(
      hostUnreachableCode(new Error('lmstudio embeddings failed: 500 Internal Error')),
    ).toBeNull();
    expect(
      hostUnreachableCode(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
    ).toBeNull();
    expect(hostUnreachableCode(null)).toBeNull();
    expect(hostUnreachableCode('ECONNREFUSED')).toBeNull();
  });

  // Code Review on PR #1341: an HTTP response proves the host answered, so a
  // provider error whose BODY mentions a system code must not classify.
  it('ignores system codes mentioned in an HTTP error body', () => {
    const http = new Error(
      'lmstudio embeddings @ http://localhost:1234/v1 failed: 503 Service Unavailable — upstream connect ECONNREFUSED 127.0.0.1:8000',
    );
    expect(hostUnreachableCode(http)).toBeNull();
    expect(isHostUnreachableError(http)).toBe(false);
    // …while the same failure shape without the HTTP status still classifies.
    expect(isRetryableEmbeddingError(http)).toBe(true);
  });

  it('counts an aggregate only when every nested attempt is unreachable', () => {
    const unreachable = (code: string) => Object.assign(new Error(`connect ${code}`), { code });
    const homogeneous = new TypeError('fetch failed', {
      cause: new AggregateError([unreachable('ECONNREFUSED'), unreachable('ENOTFOUND')]),
    });
    expect(hostUnreachableCode(homogeneous)).toBe('ECONNREFUSED');
    const mixed = new TypeError('fetch failed', {
      cause: new AggregateError([unreachable('ENETUNREACH'), unreachable('ETIMEDOUT')]),
    });
    expect(hostUnreachableCode(mixed)).toBeNull();
    expect(isHostUnreachableError(mixed)).toBe(false);
  });
});

describe('isHostUnreachableError', () => {
  it('is true only for the unreachable-host family', () => {
    expect(isHostUnreachableError(refusedError())).toBe(true);
    expect(isHostUnreachableError(dnsError())).toBe(true);
    expect(isHostUnreachableError(new TypeError('fetch failed'))).toBe(false);
    expect(isHostUnreachableError(new Error('boom'))).toBe(false);
  });
});

describe('isRetryableEmbeddingError', () => {
  it('fails fast on unreachable hosts but keeps other transient retries', () => {
    // The TRA-1798 case: still transient per isTransientError, but not retried.
    expect(isTransientError(refusedError())).toBe(true);
    expect(isRetryableEmbeddingError(refusedError())).toBe(false);
    expect(isRetryableEmbeddingError(dnsError())).toBe(false);
    // Unchanged behaviour for everything else.
    expect(isRetryableEmbeddingError(new Error('failed: 503 Service Unavailable'))).toBe(true);
    expect(isRetryableEmbeddingError(new Error('failed: 401 Unauthorized'))).toBe(false);
    expect(isRetryableEmbeddingError(new Error('boom'))).toBe(false);
  });
});

describe('withRetry + isRetryableEmbeddingError', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('attempts once and throws without retry warns on ECONNREFUSED', async () => {
    const op = vi.fn().mockRejectedValue(refusedError());
    await expect(
      withRetry(op, {
        label: 'lmstudio embeddings @ http://localhost:1234/v1',
        isRetryable: isRetryableEmbeddingError,
        initialDelayMs: 1,
      }),
    ).rejects.toThrow('fetch failed');
    expect(op).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still retries a transient 503 with the default predicate', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('failed: 503 Service Unavailable'))
      .mockResolvedValue('ok');
    await expect(withRetry(op, { label: 'embeddings', initialDelayMs: 1 })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
