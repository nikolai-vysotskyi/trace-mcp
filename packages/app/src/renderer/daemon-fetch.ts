/**
 * Every renderer read of the local daemon, with a ceiling on it (TRA-934).
 *
 * The daemon is a process that can wedge: its main thread runs synchronous
 * SQLite, and while it does, it accepts TCP connections and answers none of
 * them (TRA-922). A `fetch` with no signal against that socket never settles
 * and never rejects — the screen behind it stays on its skeleton for as long
 * as the app is open, with no error, no retry and nothing for the user to do.
 *
 * Measured 2026-09-05 with the daemon's socket held open and unanswered:
 * Overview and Activity never produced a useful frame inside 30 s; Workspace,
 * the one surface that already passed a signal, gave up at 8.06 s and painted
 * its degraded state. That is the whole difference, and it is one argument.
 *
 * The ceiling is not the fix on its own — what is behind it is. A caller that
 * aborts has to render something honest (a cached snapshot, a stated failure
 * with a retry), never a skeleton that stops animating.
 */

export const BASE = 'http://127.0.0.1:3741';

/**
 * Cap on a daemon read. Deliberately generous: this machine's daemon has been
 * measured answering `/health` in 5.8 s while indexing, so a tighter ceiling
 * would abort reads that were going to succeed. It is the *existence* of a
 * ceiling that was missing, not its value — do not tune this number without a
 * measurement that says the work legitimately finishes sooner.
 */
export const DAEMON_FETCH_TIMEOUT_MS = 8000;

/**
 * Cap on an MCP tool call issued from Notebook / Insights. Those run real
 * analysis on demand and legitimately take far longer than a read; the screen
 * shows a running state throughout. They still get a ceiling, because "running"
 * forever is the same defect wearing a spinner.
 */
export const DAEMON_TOOL_TIMEOUT_MS = 120_000;

/**
 * `fetch` against the local daemon with a bounded wait.
 *
 * An explicit `init.signal` wins — a caller that already owns cancellation
 * (a debounced search, an unmounting effect) has a better idea of when to stop
 * than a fixed timer does.
 */
export function daemonFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DAEMON_FETCH_TIMEOUT_MS,
): Promise<Response> {
  // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- BASE is the app's own local daemon (127.0.0.1), not a remote endpoint.
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}
