/**
 * Per-provider quota circuit-breaker.
 *
 * When an outbound LLM call returns `quota_exhausted` (e.g. Anthropic
 * "credit_balance_too_low", OpenAI "you exceeded your current quota") the
 * caller should NOT immediately retry the next item — every subsequent
 * request will fail the same way and burn no further quota, but each one
 * still costs a network round-trip and pollutes logs with identical errors.
 *
 * `QuotaBreaker` records the trip per-provider with a configurable cooldown.
 * `isOpen(provider)` lets callers short-circuit before the network call;
 * `tripped(provider, until?)` records a fresh trip; `reset(provider)` clears
 * it on a known-good response.
 *
 * Auth-invalid errors trip the breaker too, with a longer cooldown — there's
 * no point hammering with a bad key. Rate-limit errors do NOT trip; they're
 * handled by `withRetry` honouring `Retry-After`.
 *
 * State is in-process (no disk persistence): the breaker is per-daemon /
 * per-CLI run. A fresh run starts closed.
 */

import type { ProviderErrorKind } from './errors.js';

const DEFAULT_QUOTA_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_AUTH_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours — user must re-auth

export interface BreakerEntry {
  /** ms since epoch — call is forbidden until this point */
  openUntilMs: number;
  /** Reason recorded for the most recent trip, surfaced to logs / callers. */
  kind: ProviderErrorKind;
  /** Free-form note (e.g. provider error message) for diagnostics. */
  note?: string;
}

export class QuotaBreaker {
  private readonly entries = new Map<string, BreakerEntry>();
  private readonly clock: () => number;

  constructor(opts?: { now?: () => number }) {
    this.clock = opts?.now ?? Date.now;
  }

  /** True when the provider is currently in cooldown — caller must skip. */
  isOpen(provider: string): boolean {
    const entry = this.entries.get(provider);
    if (!entry) return false;
    if (entry.openUntilMs <= this.clock()) {
      this.entries.delete(provider);
      return false;
    }
    return true;
  }

  /**
   * Record a fresh trip. Default cooldown depends on `kind`:
   *   - `quota_exhausted` → 1h
   *   - `auth_invalid`    → 24h (user must re-auth; no point retrying sooner)
   *   - anything else     → no-op (call is left to `withRetry`)
   *
   * Pass `untilMs` to override the cooldown (e.g. honour a `Retry-After`
   * header that was much further in the future than our default).
   */
  trip(
    provider: string,
    kind: ProviderErrorKind,
    opts?: { untilMs?: number; note?: string },
  ): void {
    let cooldownMs: number | null = null;
    if (kind === 'quota_exhausted') cooldownMs = DEFAULT_QUOTA_COOLDOWN_MS;
    else if (kind === 'auth_invalid') cooldownMs = DEFAULT_AUTH_COOLDOWN_MS;
    if (cooldownMs === null) return;

    const openUntilMs = opts?.untilMs ?? this.clock() + cooldownMs;
    this.entries.set(provider, { openUntilMs, kind, note: opts?.note });
  }

  /** Clear cooldown — call after a successful response. */
  reset(provider: string): void {
    this.entries.delete(provider);
  }

  /** Inspect current state (for diagnostics / health endpoint). */
  status(provider: string): BreakerEntry | null {
    const entry = this.entries.get(provider);
    if (!entry) return null;
    if (entry.openUntilMs <= this.clock()) {
      this.entries.delete(provider);
      return null;
    }
    return { ...entry };
  }

  /** All currently-open providers, for /health surfaces. */
  allOpen(): Array<{ provider: string } & BreakerEntry> {
    const out: Array<{ provider: string } & BreakerEntry> = [];
    const now = this.clock();
    for (const [provider, entry] of this.entries) {
      if (entry.openUntilMs > now) out.push({ provider, ...entry });
    }
    return out;
  }
}

// Singleton — most callers want a process-wide breaker.
let _shared: QuotaBreaker | null = null;
export function getQuotaBreaker(): QuotaBreaker {
  if (_shared === null) _shared = new QuotaBreaker();
  return _shared;
}

/** Test-only reset hook. */
export function __resetQuotaBreakerForTests(): void {
  _shared = null;
}
