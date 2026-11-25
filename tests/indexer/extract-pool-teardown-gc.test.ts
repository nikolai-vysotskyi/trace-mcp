/**
 * V8 14+ frees a terminated worker's pages only at a later full GC; the pool
 * schedules one (debounced) after an idle teardown.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleTeardownGc, TEARDOWN_GC_DELAY_MS } from '../../src/indexer/extract-pool.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scheduleTeardownGc', () => {
  it('runs two full GCs after the delay, debounced across teardowns', () => {
    vi.useFakeTimers();
    const gc = vi.fn();
    vi.spyOn(v8, 'setFlagsFromString').mockImplementation(() => {});
    vi.spyOn(vm, 'runInNewContext').mockReturnValue(gc);
    scheduleTeardownGc(true);
    vi.advanceTimersByTime(TEARDOWN_GC_DELAY_MS - 1);
    scheduleTeardownGc(true);
    vi.advanceTimersByTime(TEARDOWN_GC_DELAY_MS - 1);
    expect(gc).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gc).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TEARDOWN_GC_DELAY_MS);
    expect(gc).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(TEARDOWN_GC_DELAY_MS * 5);
    expect(gc).toHaveBeenCalledTimes(2);
  });

  it('does nothing on runtimes that release pages themselves', () => {
    vi.useFakeTimers();
    const run = vi.spyOn(vm, 'runInNewContext');
    scheduleTeardownGc(false);
    vi.advanceTimersByTime(TEARDOWN_GC_DELAY_MS * 2);
    expect(run).not.toHaveBeenCalled();
  });
});
