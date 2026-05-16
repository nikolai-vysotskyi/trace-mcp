/**
 * ExtractPool crash-loop guard — exponential backoff, per-slot max retries,
 * and dedup'd error logging.
 *
 * Regression: a misinstalled bundle (e.g. spaced install path under macOS
 * Herd) made the worker entry fail to load with MODULE_NOT_FOUND on every
 * bootstrap. The pool respawned instantly with no cap, producing several
 * GB of identical stack traces in the daemon log within seconds. These
 * tests pin the safety behavior so the regression cannot return.
 *
 * We do not spawn real Worker threads here — we drive the private
 * `onError` / `onMessage` paths directly. The slot/respawn logic is what
 * matters; the Worker bridge is exercised by other tests + integration runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger.js';
import { ExtractPool } from '../extract-pool.js';

interface SlotInternal {
  consecutiveFailures: number;
  permanentlyDead: boolean;
  respawnTimer: NodeJS.Timeout | null;
  lastErrorKey: string | null;
  suppressedCount: number;
  suppressedSince: number;
}

interface PoolInternals {
  workers: unknown[];
  slots: SlotInternal[];
  poolDisabled: boolean;
  size: number;
  // Methods we drive directly to avoid spawning real workers.
  onError: (idx: number, err: Error) => void;
  onMessage: (idx: number, msg: { id: number; result: unknown }) => void;
  spawn: (idx: number) => void;
  makeSlot: () => SlotInternal;
}

function asInternals(p: ExtractPool): PoolInternals {
  return p as unknown as PoolInternals;
}

/** Seed N empty slots so onError has something to mutate. We deliberately do
 *  not call ensureStarted() — that would try to spawn real Workers. */
function seedSlots(p: ExtractPool, n: number): void {
  const internals = asInternals(p);
  internals.slots = [];
  for (let i = 0; i < n; i++) {
    internals.slots.push(internals.makeSlot());
  }
}

describe('ExtractPool — crash-loop guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('applies exponential backoff on respawn (200ms, 400ms, 800ms…)', () => {
    const pool = new ExtractPool({ keepAlive: true, size: 1 });
    seedSlots(pool, 1);
    const internals = asInternals(pool);
    const spawn = vi.spyOn(internals, 'spawn').mockImplementation(() => {
      /* no-op — we do not want a real Worker */
    });

    // First failure — 200ms delay.
    internals.onError(0, new Error('boom'));
    expect(spawn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(spawn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(1);

    // Second failure — 400ms.
    internals.onError(0, new Error('boom'));
    vi.advanceTimersByTime(399);
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(2);

    // Third failure — 800ms.
    internals.onError(0, new Error('boom'));
    vi.advanceTimersByTime(799);
    expect(spawn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('permanently disables a slot after MAX_CONSECUTIVE_FAILURES (5) crashes', () => {
    const pool = new ExtractPool({ keepAlive: true, size: 1 });
    seedSlots(pool, 1);
    const internals = asInternals(pool);
    vi.spyOn(internals, 'spawn').mockImplementation(() => {});

    for (let i = 0; i < 5; i++) {
      internals.onError(0, new Error('boom'));
      vi.runAllTimers();
    }

    expect(internals.slots[0].permanentlyDead).toBe(true);
  });

  it('flips the whole pool to unavailable when every slot dies', () => {
    const pool = new ExtractPool({ keepAlive: true, size: 2 });
    // resolveWorkerEntry() may return null in vitest (no bundled dist). Force
    // it on so `available` actually reflects the slot state, not the missing
    // dist file. We are testing the crash-loop guard, not entry resolution.
    (pool as unknown as { workerEntry: URL | null }).workerEntry = new URL(
      'file:///fake/worker.js',
    );
    seedSlots(pool, 2);
    const internals = asInternals(pool);
    vi.spyOn(internals, 'spawn').mockImplementation(() => {});

    expect(pool.available).toBe(true);

    for (let slot = 0; slot < 2; slot++) {
      for (let i = 0; i < 5; i++) {
        internals.onError(slot, new Error('boom'));
        vi.runAllTimers();
      }
    }

    expect(internals.poolDisabled).toBe(true);
    expect(pool.available).toBe(false);
  });

  it('extract() rejects cleanly once the pool is disabled', async () => {
    const pool = new ExtractPool({ keepAlive: true, size: 1 });
    (pool as unknown as { workerEntry: URL | null }).workerEntry = new URL(
      'file:///fake/worker.js',
    );
    seedSlots(pool, 1);
    const internals = asInternals(pool);
    vi.spyOn(internals, 'spawn').mockImplementation(() => {});

    for (let i = 0; i < 5; i++) {
      internals.onError(0, new Error('boom'));
      vi.runAllTimers();
    }
    expect(pool.available).toBe(false);

    await expect(
      pool.extract({
        relPath: 'src/x.ts',
        rootPath: '/p',
        force: false,
        existing: null,
        gitignored: false,
        workspaces: [],
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it('dedups identical errors — full stack logged once, then summary lines', () => {
    const pool = new ExtractPool({ keepAlive: true, size: 1 });
    seedSlots(pool, 1);
    const internals = asInternals(pool);
    vi.spyOn(internals, 'spawn').mockImplementation(() => {});

    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

    // 4 identical errors — below the permanently-dead threshold so we observe
    // only the dedup path, not the disable path.
    for (let i = 0; i < 4; i++) {
      internals.onError(0, new Error('MODULE_NOT_FOUND: extract-worker.js'));
      vi.runAllTimers();
    }

    // First crash logs a full error with err+stack; subsequent identical
    // crashes must NOT log a full stack (errorSpy stays at 1 call).
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatchObject({ workerIdx: 0 });
    // The duplicates accumulate as suppressedCount; with only 4 calls and
    // no time advance past 5s, we do not expect a summary warn yet.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(internals.slots[0].suppressedCount).toBe(3);

    // Push past the 5s flush window — next identical crash should flush.
    vi.advanceTimersByTime(6_000);
    internals.onError(0, new Error('MODULE_NOT_FOUND: extract-worker.js'));
    vi.runAllTimers();
    // Still only one full error log; the warn carries the summary.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();
    const [, msg] = warnSpy.mock.calls[0];
    expect(String(msg)).toMatch(/more times with same error/);
  });

  it('resets the failure budget and dedup state on a successful message', () => {
    const pool = new ExtractPool({ keepAlive: true, size: 1 });
    seedSlots(pool, 1);
    const internals = asInternals(pool);
    vi.spyOn(internals, 'spawn').mockImplementation(() => {});

    // Three crashes — below the permanent-death threshold.
    for (let i = 0; i < 3; i++) {
      internals.onError(0, new Error('boom'));
      vi.runAllTimers();
    }
    expect(internals.slots[0].consecutiveFailures).toBe(3);
    expect(internals.slots[0].lastErrorKey).toBe('boom');

    // Simulate a successful response. We bypass the pending map by passing
    // an id that isn't there — onMessage still resets slot state before
    // touching pending.
    internals.onMessage(0, { id: 999, result: { kind: 'skipped' } });

    expect(internals.slots[0].consecutiveFailures).toBe(0);
    expect(internals.slots[0].lastErrorKey).toBeNull();
    expect(internals.slots[0].suppressedCount).toBe(0);
  });

  it('caps the backoff delay at BACKOFF_CAP_MS (30s)', () => {
    const pool = new ExtractPool({ keepAlive: true, size: 1 });
    seedSlots(pool, 1);
    const internals = asInternals(pool);
    const spawn = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

    // We allow at most MAX_CONSECUTIVE_FAILURES (5) — at the 5th failure the
    // slot is marked permanently dead and no timer is scheduled. The cap
    // matters when MAX is raised; verify the helper directly.
    type WithBackoff = ExtractPool & { backoffFor: (n: number) => number };
    const p = pool as unknown as WithBackoff;
    expect(p.backoffFor(1)).toBe(200);
    expect(p.backoffFor(2)).toBe(400);
    expect(p.backoffFor(8)).toBe(25_600);
    // 2^9 * 200 = 102_400 → capped at 30_000.
    expect(p.backoffFor(10)).toBe(30_000);
    expect(p.backoffFor(20)).toBe(30_000);

    // Sanity: at least one onError was wired and would have scheduled a
    // respawn through setTimeout.
    internals.onError(0, new Error('boom'));
    vi.runAllTimers();
    expect(spawn).toHaveBeenCalled();
  });
});
