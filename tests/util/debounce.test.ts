import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trailingDebounce } from '../../src/util/debounce.js';

describe('trailingDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after waitMs on a single call', () => {
    const fn = vi.fn();
    const debounced = trailingDebounce(fn, 1000);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('coalesces multiple calls within the wait window into one fire', () => {
    const fn = vi.fn();
    const debounced = trailingDebounce(fn, 500);

    debounced('a');
    vi.advanceTimersByTime(200);
    debounced('b');
    vi.advanceTimersByTime(200);
    debounced('c');
    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('rearms after the trailing fire — separate quiet windows = separate fires', () => {
    const fn = vi.fn();
    const debounced = trailingDebounce(fn, 100);

    debounced('first');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('first');

    debounced('second');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('second');
  });

  it('flush() fires immediately and clears the pending timer', () => {
    const fn = vi.fn();
    const debounced = trailingDebounce(fn, 1000);

    debounced('pending');
    debounced.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('pending');

    // Advancing past the original wait must NOT fire again — flush cleared it.
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing pending is a no-op', () => {
    const fn = vi.fn();
    const debounced = trailingDebounce(fn, 1000);

    debounced.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel() drops the pending call without firing', () => {
    const fn = vi.fn();
    const debounced = trailingDebounce(fn, 1000);

    debounced('discard-me');
    debounced.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel() then call() rearms a fresh timer', () => {
    const fn = vi.fn();
    const debounced = trailingDebounce(fn, 1000);

    debounced('a');
    debounced.cancel();
    debounced('b');
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('a sync throw inside fn does not break subsequent fires', () => {
    let attempts = 0;
    const debounced = trailingDebounce(() => {
      attempts++;
      throw new Error('boom');
    }, 100);

    debounced();
    vi.advanceTimersByTime(100);
    expect(attempts).toBe(1);

    debounced();
    vi.advanceTimersByTime(100);
    expect(attempts).toBe(2);

    debounced();
    vi.advanceTimersByTime(100);
    expect(attempts).toBe(3);
  });

  it('an async fn that rejects does not break subsequent fires', async () => {
    let attempts = 0;
    const debounced = trailingDebounce(async () => {
      attempts++;
      throw new Error('async-boom');
    }, 100);

    debounced();
    vi.advanceTimersByTime(100);
    debounced();
    vi.advanceTimersByTime(100);
    debounced();
    vi.advanceTimersByTime(100);

    // Let the swallowed rejections settle.
    await vi.runAllTimersAsync();
    expect(attempts).toBe(3);
  });

  it('passes the latest args through to the trailing fire', () => {
    const fn = vi.fn();
    const debounced = trailingDebounce(fn, 100);

    debounced(1, 'one');
    debounced(2, 'two');
    debounced(3, 'three');
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3, 'three');
  });
});
