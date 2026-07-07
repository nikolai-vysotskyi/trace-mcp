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
 * within the deadline, the timer forces `process.exit(1)`. The timer is
 * unref'd so it never keeps the process alive on its own — if graceful
 * shutdown finishes first and exits, the timer is moot.
 */

export interface BoundedShutdownOptions {
  /** Hard-exit deadline in ms after graceful shutdown starts. Default 5_000. */
  deadlineMs?: number;
  /** Injectable for tests. Defaults to `process.exit`. */
  exitFn?: (code: number) => void;
  /** Injectable for tests. Defaults to Node's `setTimeout`. */
  setTimeoutFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
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
  } = options;

  const timer = setTimeoutFn(() => {
    // Graceful shutdown didn't finish in time — force death so an orphaned or
    // wedged session cannot survive SIGTERM.
    exitFn(1);
  }, deadlineMs);

  // Never let the deadline timer itself hold the process open.
  timer.unref?.();

  // Reason is accepted for symmetry / future logging hooks; the caller logs.
  void reason;

  return timer;
}
