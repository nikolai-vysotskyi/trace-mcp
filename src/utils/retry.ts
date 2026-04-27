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

      const delay = Math.min(initialDelay * Math.pow(backoffFactor, attempt - 1), maxDelay);
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
