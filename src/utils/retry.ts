/**
 * Retry utility with exponential backoff for transient failures.
 */
import { logger } from '../logger.js';

interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Initial delay in ms before first retry. Default: 500 */
  initialDelayMs?: number;
  /** Backoff multiplier. Default: 2 */
  backoffFactor?: number;
  /** Maximum delay between retries in ms. Default: 10000 */
  maxDelayMs?: number;
  /** Label for log messages. */
  label?: string;
  /** Predicate: return true if the error is retryable. Default: retries on network/rate-limit errors. */
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_DELAY_MS = 10_000;

/** Default retryable check: network errors, timeouts, 429, 500, 502, 503, 504. */
export function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // AbortError = timeout, fetch failures
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    if (
      msg.includes('fetch failed') ||
      msg.includes('network') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up')
    )
      return true;
    // HTTP status codes in error messages
    if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
  }
  return false;
}

/**
 * Node error codes meaning "the host itself is unreachable" — nothing is
 * listening (ECONNREFUSED, e.g. LM Studio / Ollama not running), DNS doesn't
 * resolve (ENOTFOUND), or the network path is down (EHOSTUNREACH/ENETUNREACH).
 * Unlike timeouts or 5xx, these never resolve within a retry backoff: the
 * environment is missing, not slow. Deliberately narrow — EAI_AGAIN (transient
 * DNS), ECONNRESET (mid-stream reset) and bare "fetch failed" stay retryable.
 */
const HOST_UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * Short machine-readable reason for an unreachable-host failure (e.g.
 * 'ECONNREFUSED'), or null when the error isn't in that class. Walks the
 * `cause` chain because undici surfaces connection failures as
 * `TypeError: fetch failed` with the real code nested in
 * `cause: AggregateError [ECONNREFUSED]` (TRA-1798).
 */
export function hostUnreachableCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const rec = current as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
    if (typeof rec.code === 'string' && HOST_UNREACHABLE_CODES.has(rec.code)) {
      return rec.code;
    }
    if (typeof rec.message === 'string') {
      const msg = rec.message.toLowerCase();
      for (const code of HOST_UNREACHABLE_CODES) {
        if (msg.includes(code.toLowerCase())) return code;
      }
    }
    // AggregateError from undici nests one error per resolved address.
    if (Array.isArray(rec.errors)) stack.push(...rec.errors);
    if (rec.cause !== undefined) stack.push(rec.cause);
  }
  return null;
}

/** True when the error means the remote host is unreachable (see above). */
export function isHostUnreachableError(error: unknown): boolean {
  return hostUnreachableCode(error) !== null;
}

/**
 * Retry predicate for background embedding calls. Identical to
 * {@link isTransientError} except host-unreachable failures fail fast: when
 * LM Studio / Ollama isn't running, three attempts with backoff only delay
 * the pipeline by ~1.5s and log two L40 retry warns per daemon start for an
 * endpoint that cannot answer. The embedding pipeline's circuit breaker owns
 * the pause-and-retry-later policy instead (TRA-1798). Inference (user-facing)
 * keeps the default predicate — a retry there can still save a query.
 */
export function isRetryableEmbeddingError(error: unknown): boolean {
  return isTransientError(error) && !isHostUnreachableError(error);
}

/**
 * Execute `fn` with retry on transient failures.
 *
 * @example
 * const result = await withRetry(() => fetch(url), { label: 'embeddings', maxAttempts: 3 });
 */
export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelay = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const backoffFactor = options?.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const maxDelay = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const label = options?.label ?? 'operation';
  const isRetryable = options?.isRetryable ?? isTransientError;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error;
      }

      const delay = Math.min(initialDelay * backoffFactor ** (attempt - 1), maxDelay);
      // Add jitter (±25%) to avoid thundering herd
      const jitter = delay * (0.75 + Math.random() * 0.5);

      logger.warn(
        {
          attempt,
          maxAttempts,
          delayMs: Math.round(jitter),
          error: error instanceof Error ? error.message : String(error),
        },
        `${label}: transient failure, retrying`,
      );

      await new Promise((resolve) => setTimeout(resolve, jitter));
    }
  }

  throw lastError;
}
