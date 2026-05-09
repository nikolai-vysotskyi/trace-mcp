/**
 * Cross-provider error classification + retry helper.
 *
 * Why this module exists
 * ──────────────────────
 * Each AI provider (Anthropic, OpenAI, Voyage, Gemini, Vertex, Ollama, …)
 * surfaces failures in a different shape: HTTP status, custom JSON body,
 * SDK-specific Error subclass, network-layer error. Without a shared
 * vocabulary the call sites either retry-on-everything (burning quota on
 * 401/400) or never retry (failing on transient 502s).
 *
 * `ClassifiedProviderError.kind` is the shared vocabulary:
 *
 *   - `transient`         — 5xx, ECONNRESET, ETIMEDOUT, fetch abort. Retry.
 *   - `rate_limit`        — 429, "rate limit exceeded". Retry with longer
 *                           backoff; if a `Retry-After` is provided, honour
 *                           it. Eventually surface to caller.
 *   - `quota_exhausted`   — billing/usage cap hit (401 with quota body, or
 *                           403 with "credit"/"insufficient quota"). DO NOT
 *                           retry — burns no further quota; surface with the
 *                           classified `kind` so the caller (e.g. an
 *                           embedding loop) can stop and notify the user.
 *   - `auth_invalid`      — 401/403 from a key that's malformed or revoked.
 *                           Do not retry; ask user to re-auth.
 *   - `unrecoverable`     — 4xx other than the above (400 bad input, 404
 *                           missing model, 422 validation). Do not retry;
 *                           the next attempt will fail the same way.
 *   - `unknown`           — anything we couldn't pattern-match. Caller may
 *                           retry once, conservatively.
 *
 * `withRetry()` wraps an async operation and retries `transient` /
 * `rate_limit` with exponential backoff + jitter, honouring `Retry-After`
 * when present, abandoning early on `quota_exhausted` / `auth_invalid` /
 * `unrecoverable`. Captures `request_id` (when surfaced by the provider)
 * for log dedup.
 */

import { logger } from '../logger.js';

export type ProviderErrorKind =
  | 'transient'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'unrecoverable'
  | 'unknown';

export class ClassifiedProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;
  readonly provider: string;
  readonly cause?: unknown;

  constructor(
    provider: string,
    kind: ProviderErrorKind,
    message: string,
    opts?: {
      status?: number | null;
      retryAfterMs?: number | null;
      requestId?: string | null;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'ClassifiedProviderError';
    this.provider = provider;
    this.kind = kind;
    this.status = opts?.status ?? null;
    this.retryAfterMs = opts?.retryAfterMs ?? null;
    this.requestId = opts?.requestId ?? null;
    this.cause = opts?.cause;
  }
}

// ── Pattern-based classifier ────────────────────────────────────────

interface ProviderErrorShape {
  status?: number | null;
  message?: string;
  body?: string | null;
  retryAfter?: string | number | null;
  requestId?: string | null;
}

const QUOTA_PATTERNS = [
  /insufficient[_ ]?(?:quota|credit)/i,
  /quota[_ ]?exhausted/i,
  /usage[_ ]?cap/i,
  /credit[_ ]?balance[_ ]?too[_ ]?low/i,
  /you exceeded your current quota/i,
];

const AUTH_PATTERNS = [
  /invalid[_ ]?api[_ ]?key/i,
  /authentication[_ ]?failed/i,
  /unauthorized/i,
  /api[_ ]?key.*(?:not found|revoked|missing)/i,
  /please.*(?:re[- ]?login|sign in)/i,
];

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function parseRetryAfter(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return value > 0 ? value * 1000 : null;
  // Numeric seconds.
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  // HTTP date.
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    const delta = parsed - Date.now();
    return delta > 0 ? delta : null;
  }
  return null;
}

export function classifyProviderError(provider: string, err: unknown): ClassifiedProviderError {
  if (err instanceof ClassifiedProviderError) return err;

  const shape = extractErrorShape(err);
  const haystack = `${shape.message ?? ''} ${shape.body ?? ''}`.toLowerCase();
  const status = shape.status ?? null;
  const retryAfterMs = parseRetryAfter(shape.retryAfter);
  const requestId = shape.requestId ?? null;

  let kind: ProviderErrorKind;
  // Quota check FIRST — quota messages routinely arrive with a 429 status
  // ("you exceeded your current quota") or 401/403; classifying them as
  // generic rate_limit/auth_invalid would trigger pointless retries that
  // burn no further quota but pollute logs.
  if (QUOTA_PATTERNS.some((p) => p.test(haystack))) {
    kind = 'quota_exhausted';
  } else if (status === 429 || /rate[_ ]?limit/i.test(haystack)) {
    kind = 'rate_limit';
  } else if (status === 401 || status === 403 || AUTH_PATTERNS.some((p) => p.test(haystack))) {
    kind = 'auth_invalid';
  } else if (status !== null && status >= 500 && status < 600) {
    kind = 'transient';
  } else if (status !== null && status >= 400 && status < 500) {
    kind = 'unrecoverable';
  } else if (isTransientNetworkError(err)) {
    kind = 'transient';
  } else {
    kind = 'unknown';
  }

  const message =
    shape.message ?? (err instanceof Error ? err.message : String(err)) ?? `${provider} error`;

  return new ClassifiedProviderError(provider, kind, message, {
    status,
    retryAfterMs,
    requestId,
    cause: err,
  });
}

function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return true;
  // fetch AbortError / TimeoutError surface as `name` not `code`.
  const name = (err as { name?: unknown }).name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return false;
}

function extractErrorShape(err: unknown): ProviderErrorShape {
  if (!err || typeof err !== 'object') {
    return { message: String(err) };
  }
  const e = err as Record<string, unknown>;
  const headers = (e.headers ?? e.responseHeaders) as Record<string, string | string[]> | undefined;

  const headerVal = (name: string): string | null => {
    if (!headers) return null;
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lower) {
        return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      }
    }
    return null;
  };

  // SDK and fetch shapes both observed across providers.
  const status =
    pickNumber(e.status) ??
    pickNumber(e.statusCode) ??
    pickNumber((e.response as Record<string, unknown> | undefined)?.status);

  const body =
    typeof e.body === 'string'
      ? e.body
      : typeof (e.response as Record<string, unknown> | undefined)?.data === 'string'
        ? ((e.response as Record<string, unknown>).data as string)
        : null;

  return {
    status,
    message: typeof e.message === 'string' ? e.message : undefined,
    body,
    retryAfter: headerVal('retry-after'),
    requestId:
      headerVal('x-request-id') ??
      headerVal('request-id') ??
      (typeof e.request_id === 'string' ? (e.request_id as string) : null),
  };
}

function pickNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

// ── Retry helper ────────────────────────────────────────────────────

export interface WithRetryOptions {
  /** Provider label used in error messages and logs. */
  provider: string;
  /** Max total attempts including the first (default 4). */
  maxAttempts?: number;
  /** Base backoff in ms (default 500). */
  baseDelayMs?: number;
  /** Cap on backoff per attempt (default 30s). */
  maxDelayMs?: number;
  /** Jitter ratio in [0,1] applied to each backoff (default 0.3). */
  jitter?: number;
  /** AbortSignal for cancellation between retries. */
  signal?: AbortSignal;
  /**
   * Override which kinds are retryable. Default:
   *   `transient` and `rate_limit`.
   */
  retryKinds?: ReadonlySet<ProviderErrorKind>;
}

const DEFAULT_RETRY_KINDS: ReadonlySet<ProviderErrorKind> = new Set(['transient', 'rate_limit']);

export async function withRetry<T>(
  op: (attempt: number) => Promise<T>,
  opts: WithRetryOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const baseDelayMs = Math.max(1, opts.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, opts.maxDelayMs ?? 30_000);
  const jitter = Math.min(1, Math.max(0, opts.jitter ?? 0.3));
  const retryKinds = opts.retryKinds ?? DEFAULT_RETRY_KINDS;

  let lastErr: ClassifiedProviderError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new ClassifiedProviderError(opts.provider, 'unrecoverable', 'aborted by caller');
    }
    try {
      return await op(attempt);
    } catch (err) {
      const classified = classifyProviderError(opts.provider, err);
      lastErr = classified;

      // Non-retryable: stop immediately.
      if (!retryKinds.has(classified.kind) || attempt === maxAttempts) {
        throw classified;
      }

      const backoff = computeBackoff({
        attempt,
        baseDelayMs,
        maxDelayMs,
        jitter,
        retryAfterMs: classified.retryAfterMs,
      });

      logger.debug?.(
        {
          provider: opts.provider,
          kind: classified.kind,
          status: classified.status,
          requestId: classified.requestId,
          attempt,
          maxAttempts,
          backoffMs: backoff,
        },
        'withRetry: retrying after classified provider error',
      );

      await sleep(backoff, opts.signal);
    }
  }

  // Should never reach here — the loop always either returns or throws.
  throw lastErr ?? new ClassifiedProviderError(opts.provider, 'unknown', 'withRetry exhausted');
}

interface BackoffArgs {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  retryAfterMs: number | null;
}

export function computeBackoff(args: BackoffArgs): number {
  // If the provider gave us a Retry-After, honour it (capped at maxDelayMs).
  if (args.retryAfterMs !== null && args.retryAfterMs > 0) {
    return Math.min(args.retryAfterMs, args.maxDelayMs);
  }
  // Exponential: base * 2^(attempt-1), capped, then jittered.
  const exp = Math.min(args.baseDelayMs * 2 ** (args.attempt - 1), args.maxDelayMs);
  const jitterRange = exp * args.jitter;
  const offset = (Math.random() - 0.5) * 2 * jitterRange;
  return Math.max(0, Math.round(exp + offset));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
