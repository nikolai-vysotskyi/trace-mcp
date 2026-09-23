/**
 * Startup watchdog (TRA-1843).
 *
 * `loadAllRegistered()` is `allSettled` over per-project setup, so one wedged
 * project used to hold `/health` at `status: "starting"` forever: clients kept
 * waiting/backing off on a daemon that would never report ready, and nothing
 * in the log named the wedge. The setup-slot timeouts and the `addProject()`
 * teardown bound the known hang paths; this bounds the unknown ones — if
 * startup has not finished within the budget, say so loudly (naming the stuck
 * roots) and report ready anyway. Flipping is safe by the design the
 * `serve-http` action already documents: per-project `indexing` status still
 * gates 503 + Retry-After while a project warms, so `ok` only ever means
 * "serving", never "every index finished".
 */

export const STARTUP_WATCHDOG_MS = 15 * 60_000;

export interface StartupWatchdogOpts {
  /** Budget before the watchdog fires. Defaults to STARTUP_WATCHDOG_MS. */
  timeoutMs?: number;
  /** Roots still holding startup open (starting/indexing) at fire time. */
  getStuckRoots: () => string[];
  /** Runs exactly once when the budget expires before disarm. */
  onStuck: (stuckRoots: string[]) => void;
  /** Timer seams — production passes nothing; tests pass fakes. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Arm the watchdog. Returns a disarm function the caller runs the moment
 * startup finishes — after that the watchdog can never fire. The timer is
 * unref'd so it never keeps the daemon process alive on its own.
 */
export function armStartupWatchdog(opts: StartupWatchdogOpts): () => void {
  const timeoutMs = opts.timeoutMs ?? STARTUP_WATCHDOG_MS;
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  const timer = setT(() => {
    let stuck: string[] = [];
    try {
      stuck = opts.getStuckRoots();
    } catch {
      /* diagnostics must never break the flip below */
    }
    opts.onStuck(stuck);
  }, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearT(timer);
}
