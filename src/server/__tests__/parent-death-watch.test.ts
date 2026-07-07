import { afterEach, describe, expect, it, vi } from 'vitest';
import { startParentDeathWatch } from '../parent-death-watch.js';

// Issue #236 defect 1b: orphaned stdio sessions kept running with ppid=1 (host
// long dead) because their stdin fd stayed open via an inherited pipe, so the
// stdin-close handler never fired. A cheap ppid poll is the fallback that
// catches them. These tests drive the poll with a fake timer + injected ppid.

describe('startParentDeathWatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires onOrphan once when the process becomes reparented to init (ppid=1)', () => {
    let ppid = 4242; // started with a real parent
    const onOrphan = vi.fn();
    // Manual interval driver — no real timers. Held in a mutable object so TS
    // doesn't narrow it to null across the callback boundary.
    const driver: { tick: () => void } = { tick: () => {} };
    const stop = startParentDeathWatch(onOrphan, {
      intervalMs: 30_000,
      getPpid: () => ppid,
      getPlatform: () => 'darwin',
      setIntervalFn: (handler) => {
        driver.tick = handler;
        return { unref: () => {} } as unknown as NodeJS.Timeout;
      },
      clearIntervalFn: () => {},
    });

    // Parent still alive → no shutdown.
    driver.tick();
    expect(onOrphan).not.toHaveBeenCalled();

    // Parent dies → reparented to init.
    ppid = 1;
    driver.tick();
    expect(onOrphan).toHaveBeenCalledTimes(1);
    expect(onOrphan).toHaveBeenCalledWith(expect.stringContaining('ppid=1'));

    // Idempotent: further ticks do not re-fire.
    driver.tick();
    expect(onOrphan).toHaveBeenCalledTimes(1);
    stop();
  });

  it('is a no-op when the process already has ppid=1 at startup (supervised daemon)', () => {
    const onOrphan = vi.fn();
    const setIntervalFn = vi.fn();
    startParentDeathWatch(onOrphan, {
      getPpid: () => 1,
      getPlatform: () => 'linux',
      setIntervalFn: setIntervalFn as never,
      clearIntervalFn: () => {},
    });
    // Never installs a poll — a launchd/systemd daemon must not self-terminate.
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(onOrphan).not.toHaveBeenCalled();
  });

  it('is a no-op on win32 (no init-reparenting semantics)', () => {
    const onOrphan = vi.fn();
    const setIntervalFn = vi.fn();
    startParentDeathWatch(onOrphan, {
      getPpid: () => 4242,
      getPlatform: () => 'win32',
      setIntervalFn: setIntervalFn as never,
      clearIntervalFn: () => {},
    });
    expect(setIntervalFn).not.toHaveBeenCalled();
  });

  it('stop() clears the interval so the OS stops driving the poll', () => {
    const onOrphan = vi.fn();
    const cleared: NodeJS.Timeout[] = [];
    const handle = { unref: () => {} } as unknown as NodeJS.Timeout;
    const stop = startParentDeathWatch(onOrphan, {
      getPpid: () => 4242,
      getPlatform: () => 'darwin',
      setIntervalFn: () => handle,
      clearIntervalFn: (h) => cleared.push(h),
    });

    stop();
    // Clearing the interval is what stops the OS from ever ticking again.
    expect(cleared).toContain(handle);
    expect(onOrphan).not.toHaveBeenCalled();
  });
});
