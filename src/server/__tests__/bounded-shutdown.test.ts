import { describe, expect, it, vi } from 'vitest';
import { armBoundedExit } from '../bounded-shutdown.js';

// Issue #236 defect 2 (and #237 daemon path): SIGTERM'd sessions/daemons
// survived because graceful shutdown could hang (a drain that never resolves,
// or the event loop starved so the async continuation never ran) — only
// SIGKILL worked. armBoundedExit guarantees the process dies within a bounded
// time by arming an unref'd hard-exit timer.

describe('armBoundedExit', () => {
  it('forces process.exit(1) after the deadline elapses', () => {
    const exitFn = vi.fn();
    // Held in a mutable object so TS doesn't narrow it to null across the
    // callback boundary.
    const driver: { fire: () => void } = { fire: () => {} };
    const timer = armBoundedExit('SIGTERM', {
      deadlineMs: 5_000,
      exitFn,
      setTimeoutFn: (handler) => {
        driver.fire = handler;
        return { unref: () => {} } as unknown as NodeJS.Timeout;
      },
    });

    // Before the deadline: no exit.
    expect(exitFn).not.toHaveBeenCalled();

    // Deadline elapses → hard exit with code 1.
    driver.fire();
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(1);
    expect(timer).toBeDefined();
  });

  it('unref()s the timer so it never keeps the process alive on its own', () => {
    const unref = vi.fn();
    armBoundedExit('SIGINT', {
      exitFn: vi.fn(),
      setTimeoutFn: () => ({ unref }) as unknown as NodeJS.Timeout,
    });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('defaults to a 5s deadline', () => {
    let capturedMs = -1;
    armBoundedExit('SIGTERM', {
      exitFn: vi.fn(),
      setTimeoutFn: (_handler, ms) => {
        capturedMs = ms;
        return { unref: () => {} } as unknown as NodeJS.Timeout;
      },
    });
    expect(capturedMs).toBe(5_000);
  });
});
