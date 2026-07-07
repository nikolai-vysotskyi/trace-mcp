/**
 * Parent-death detection for stdio session servers (issue #236).
 *
 * An MCP stdio session is spawned by a host (Claude, an editor, a CLI) and is
 * meant to live exactly as long as that host. Normally the host closing stdin
 * (EOF) tears the session down. But in the field we saw ~20 orphaned
 * `trace-mcp serve` processes with `ppid === 1` (their host long dead), aged
 * 13–20 h, each burning CPU on watchers + periodic reindex with nobody
 * consuming the results. Their stdin never reached EOF — the fd stayed open via
 * an inherited pipe — so the stdin-close handler never fired.
 *
 * A cheap `process.ppid === 1` poll (every 30 s by default) is the belt to
 * stdin-close's braces: on unix a reparented-to-init process has ppid 1, which
 * is an unambiguous "my parent is gone" signal for a session that was NOT
 * started by init itself.
 *
 * We deliberately skip the poll when the process is ALREADY a child of init at
 * startup — daemons launched by launchd/systemd legitimately have ppid 1 and
 * must not self-terminate. Only a session that STARTED with a real parent and
 * later became reparented to init is an orphan.
 */

export interface ParentDeathWatchOptions {
  /** Poll cadence in ms. Default 30_000. */
  intervalMs?: number;
  /** Injectable for tests. Defaults to `() => process.ppid`. */
  getPpid?: () => number;
  /** Injectable for tests. Defaults to `() => process.platform`. */
  getPlatform?: () => NodeJS.Platform;
  /** Injectable for tests. Defaults to Node's timers. */
  setIntervalFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
}

/**
 * Start watching for parent death. Calls `onOrphan(reason)` exactly once when
 * the process becomes reparented to init (ppid 1) after having started with a
 * real parent. Returns a `stop()` to cancel the watch.
 *
 * No-op (returns a no-op stopper) when:
 *   - not on a unix-like platform (win32 has no ppid-1 reparenting semantics), or
 *   - the process already has ppid 1 at start (launchd/systemd-managed daemon).
 */
export function startParentDeathWatch(
  onOrphan: (reason: string) => void,
  options: ParentDeathWatchOptions = {},
): () => void {
  const {
    intervalMs = 30_000,
    getPpid = () => process.ppid,
    getPlatform = () => process.platform,
    setIntervalFn = (handler, ms) => setInterval(handler, ms),
    clearIntervalFn = (handle) => clearInterval(handle),
  } = options;

  // Windows has no init-reparenting; the stdin-close path covers it there.
  if (getPlatform() === 'win32') {
    return () => {};
  }

  // Already a child of init at startup → this is a supervised daemon, not an
  // orphaned session. Never self-terminate on ppid 1 in that case.
  if (getPpid() === 1) {
    return () => {};
  }

  let fired = false;
  let handle: NodeJS.Timeout | null = setIntervalFn(() => {
    if (fired) return;
    if (getPpid() === 1) {
      fired = true;
      if (handle) {
        clearIntervalFn(handle);
        handle = null;
      }
      onOrphan('parent-death (ppid=1)');
    }
  }, intervalMs);

  // Don't let the poll keep an otherwise-idle process alive.
  handle.unref?.();

  return () => {
    if (handle) {
      clearIntervalFn(handle);
      handle = null;
    }
  };
}
