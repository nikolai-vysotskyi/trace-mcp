import { describe, expect, it, vi } from 'vitest';
import { armBoundedExit, DAEMON_SHUTDOWN_DEADLINE_MS } from '../bounded-shutdown.js';

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

  // TRA-849: the forced exit reported code 1 on stops the user asked for. On a
  // real machine 15 of 27 SIGTERM stops with a launchd post-mortem exited 1 —
  // launchd logged a failed exit and `daemon status` said `last exit: 1` for a
  // daemon that was simply told to stop.
  it('exits with the caller-chosen code, and runs onTimeout before exiting', () => {
    const exitFn = vi.fn();
    const onTimeout = vi.fn();
    const driver: { fire: () => void } = { fire: () => {} };
    armBoundedExit('SIGTERM', {
      exitFn,
      exitCode: 0,
      onTimeout,
      setTimeoutFn: (handler) => {
        driver.fire = handler;
        return { unref: () => {} } as unknown as NodeJS.Timeout;
      },
    });

    driver.fire();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
    // Order matters: the hook records the clean stop and drops the PID file,
    // which is pointless after the process is gone.
    expect(onTimeout.mock.invocationCallOrder[0]).toBeLessThan(
      exitFn.mock.invocationCallOrder[0],
    );
  });

  it('still exits when onTimeout throws', () => {
    const exitFn = vi.fn();
    const driver: { fire: () => void } = { fire: () => {} };
    armBoundedExit('SIGTERM', {
      exitFn,
      exitCode: 0,
      onTimeout: () => {
        throw new Error('telemetry write failed');
      },
      setTimeoutFn: (handler) => {
        driver.fire = handler;
        return { unref: () => {} } as unknown as NodeJS.Timeout;
      },
    });

    expect(() => driver.fire()).not.toThrow();
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('keeps the daemon deadline under launchd ExitTimeOut, and above the old 5s', () => {
    // Below 30s (PLIST_EXIT_TIMEOUT_SEC) so we decide when to give up rather
    // than taking a SIGKILL mid-cleanup; well above 5s, which cut off cleanup
    // runs that legitimately took 5-27s.
    expect(DAEMON_SHUTDOWN_DEADLINE_MS).toBeLessThan(30_000);
    expect(DAEMON_SHUTDOWN_DEADLINE_MS).toBeGreaterThan(5_000);
  });
});
