/**
 * AbortSignal threading for trailingDebounce.
 *
 * Validates the cancellation contract introduced so that
 * ProjectManager.stopProject() can abort in-flight AI fetches instead of
 * letting them run to completion against a disposed Store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trailingDebounce } from '../../src/util/debounce.js';

describe('trailingDebounce — AbortSignal threading', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes a non-aborted signal before the first invocation', () => {
    const debounced = trailingDebounce(() => undefined, 100);
    expect(debounced.signal).toBeInstanceOf(AbortSignal);
    expect(debounced.signal.aborted).toBe(false);
  });

  it('cancel() aborts the in-flight controller — the wrapped op sees signal.aborted=true', async () => {
    // The wrapped op resolves when its signal is aborted. We grab the signal
    // out of the debounced wrapper at fire time and assert that .cancel()
    // flips it to aborted while the fn is still awaiting.
    let seenSignal: AbortSignal | undefined;
    const opEntered = vi.fn();
    const debounced = trailingDebounce(async () => {
      seenSignal = debounced.signal;
      opEntered();
      // Park the op so cancel() races against an in-flight invocation.
      await new Promise<void>((resolve) => {
        if (debounced.signal.aborted) resolve();
        else debounced.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }, 100);

    debounced();
    await vi.advanceTimersByTimeAsync(100);
    expect(opEntered).toHaveBeenCalledTimes(1);
    expect(seenSignal!.aborted).toBe(false);

    // Cancel while the op is parked on the signal — it must fire.
    debounced.cancel();
    expect(seenSignal!.aborted).toBe(true);

    // Drain the microtask queue so the op's await resolves.
    await vi.runAllTimersAsync();
  });

  it('repeated invocations get fresh signals — aborting one does not affect the next', async () => {
    const signalsObservedAtFire: AbortSignal[] = [];
    const debounced = trailingDebounce(() => {
      signalsObservedAtFire.push(debounced.signal);
    }, 100);

    // First fire window.
    debounced();
    await vi.advanceTimersByTimeAsync(100);
    expect(signalsObservedAtFire).toHaveLength(1);
    const firstSignal = signalsObservedAtFire[0];
    expect(firstSignal.aborted).toBe(false);

    // Abort the first invocation explicitly.
    debounced.cancel();
    expect(firstSignal.aborted).toBe(true);

    // A second invocation must mint a fresh, non-aborted controller.
    debounced();
    await vi.advanceTimersByTimeAsync(100);
    expect(signalsObservedAtFire).toHaveLength(2);
    const secondSignal = signalsObservedAtFire[1];
    expect(secondSignal).not.toBe(firstSignal);
    expect(secondSignal.aborted).toBe(false);
    // First signal stays aborted — proves the controllers are independent.
    expect(firstSignal.aborted).toBe(true);
  });

  it('cancel() with no pending invocation aborts the current controller too', () => {
    // Defensive: stopProject() calls .cancel() unconditionally. Even when no
    // fire is pending, the abort still propagates so anything that captured
    // the .signal reference earlier still sees aborted=true.
    const debounced = trailingDebounce(() => undefined, 100);
    const observed = debounced.signal;

    debounced.cancel();
    expect(observed.aborted).toBe(true);
  });

  it('cancel() is idempotent — calling it twice does not throw', () => {
    const debounced = trailingDebounce(() => undefined, 100);
    debounced.cancel();
    expect(() => debounced.cancel()).not.toThrow();
    expect(debounced.signal.aborted).toBe(true);
  });

  it('flush() preserves the signal for the synchronous fire', () => {
    let seenSignal: AbortSignal | undefined;
    const debounced = trailingDebounce(() => {
      seenSignal = debounced.signal;
    }, 1000);
    debounced();
    debounced.flush();
    expect(seenSignal).toBeDefined();
    expect(seenSignal!.aborted).toBe(false);
  });
});
