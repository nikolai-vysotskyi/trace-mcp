/**
 * Bounded graceful shutdown for stdio session servers (issue #236, defect 2).
 *
 * Orphaned sessions survived a plain `kill` (SIGTERM) and only died to
 * SIGKILL. The SIGTERM handler kicked off `session.shutdown()` and awaited it —
 * but graceful shutdown can hang (a drain that never resolves, or the event
 * loop starved by a synchronous indexing loop so the async continuation never
 * runs). With nothing bounding it, the process lived forever.
 *
 * The fix: when a shutdown signal arrives, start graceful shutdown AND arm a
 * short unref'd timer. If graceful shutdown hasn't called `process.exit()`
 * within the deadline, the timer forces an exit. The timer is unref'd so it
 * never keeps the process alive on its own — if graceful shutdown finishes
 * first and exits, the timer is moot.
 *
 * TRA-849: that forced exit used to be hard-coded to code 1. Overrunning the
 * deadline of a *requested* stop is not a crash, but launchd, `daemon status`
 * and the clean-stop telemetry all read it as one — 56% of ordinary SIGTERM
 * stops on a real machine were recorded as failures. Callers now choose the
 * code and get an `onTimeout` hook to log the overrun and settle their books
 * before the process dies.
 */

/**
 * Deadline for the HTTP daemon's graceful shutdown.
 *
 * Must stay below `PLIST_EXIT_TIMEOUT_SEC` (30s) in `src/daemon/lifecycle.ts`,
 * `scripts/postinstall-control-plane.mjs` and
 * `packages/app/src/main/daemon-plist.ts` so *we* decide when to give up, not
 * launchd's SIGKILL. The old 5s cut off cleanup that legitimately runs longer:
 * `stopProject()` awaits each project's in-flight initial index, and on a
 * machine with dozens of registered projects that regularly took 5-27s.
 */
export const DAEMON_SHUTDOWN_DEADLINE_MS = 20_000;

export interface BoundedShutdownOptions {
  /** Hard-exit deadline in ms after graceful shutdown starts. Default 5_000. */
  deadlineMs?: number;
  /** Injectable for tests. Defaults to `process.exit`. */
  exitFn?: (code: number) => void;
  /** Injectable for tests. Defaults to Node's `setTimeout`. */
  setTimeoutFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
  /**
   * Exit code for the forced exit. Default 1 — kept for callers that really are
   * reporting a failure. Pass 0 when the stop was requested and only its
   * cleanup ran long (TRA-849).
   */
  exitCode?: number;
  /**
   * Called just before the forced exit — the last chance to log the overrun or
   * record state. Runs synchronously; anything async is lost.
   */
  onTimeout?: () => void;
}

/**
 * Arm a bounded hard-exit. Returns a handle that must be `unref`'d (already
 * done here) — the caller does not need to clear it: once graceful shutdown
 * calls `process.exit()`, the whole process dies and the timer is irrelevant.
 *
 * Returns the timer so tests can assert it was armed / trigger it.
 */
export function armBoundedExit(
  reason: string,
  options: BoundedShutdownOptions = {},
): NodeJS.Timeout {
  const {
    deadlineMs = 5_000,
    exitFn = (code: number) => process.exit(code),
    setTimeoutFn = (handler, ms) => setTimeout(handler, ms),
    exitCode = 1,
    onTimeout,
  } = options;

  const timer = setTimeoutFn(() => {
    // Graceful shutdown didn't finish in time — force death so an orphaned or
    // wedged session cannot survive SIGTERM.
    try {
      onTimeout?.();
    } catch {
      /* bookkeeping must never keep a wedged process alive */
    }
    exitFn(exitCode);
  }, deadlineMs);

  // Never let the deadline timer itself hold the process open.
  timer.unref?.();

  // Reason is accepted for symmetry / future logging hooks; the caller logs.
  void reason;

  return timer;
}
