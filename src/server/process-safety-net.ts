/**
 * Last-resort process error handlers for the long-lived server processes
 * (`serve` stdio + `serve-http` daemon).
 *
 * Why this exists: on Node 20+, an unhandled promise rejection terminates the
 * process by default, and an uncaught exception always does. For an MCP server
 * that means a single stray async error *anywhere* — a tool handler, a
 * background indexing task, a watcher callback, an AI/DB hiccup — tears down the
 * whole session, and the client sees the server vanish ("disconnects" /
 * "crashes" with no obvious cause). Logging the error and keeping the process
 * alive is the right tradeoff for a server whose only alternative is dropping
 * every connected client.
 *
 * Errors are logged via pino, which writes to stderr/file — never stdout, which
 * carries the stdio JSON-RPC stream. So this is safe in stdio mode.
 *
 * Tradeoff acknowledged: an uncaught exception can in theory leave global state
 * inconsistent. In practice, for this process the value of not dropping the
 * client's session outweighs that risk, and every such event is logged loudly
 * for triage.
 */

import { logger } from '../logger.js';

let installed = false;

/** Normalise any thrown value into a loggable shape. */
export function formatErr(e: unknown): { message: string; stack?: string } | { value: string } {
  if (e instanceof Error) {
    return { message: e.message, stack: e.stack };
  }
  return { value: String(e) };
}

/**
 * True when the error means the process can no longer write its own logs —
 * a closed/destroyed stdout or stderr pipe. Keeping the process alive in that
 * state is what produces the 100%-CPU orphan described in the handler below.
 */
export function isBrokenLogSink(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
  );
}

/**
 * Install `unhandledRejection` + `uncaughtException` handlers that log and keep
 * the process alive. Idempotent — safe to call from multiple entry points.
 *
 * @param context short label for the log line (e.g. "serve", "serve-http").
 */
export function installProcessSafetyNet(context: string): void {
  if (installed) return;
  installed = true;

  process.on('unhandledRejection', (reason) => {
    logger.error(
      { err: formatErr(reason), context },
      'Unhandled promise rejection — server kept alive (safety net)',
    );
  });

  process.on('uncaughtException', (err) => {
    // EPIPE here means our own log sink is gone: the parent that owned our
    // stdout/stderr pipe exited without killing us. Logging writes to the dead
    // pipe, which throws EPIPE again, which re-enters this handler — the process
    // spins at ~100% CPU forever and never releases its port. Measured on an
    // orphaned `serve-http`: 356 CPU-minutes over 5h56m with zero clients
    // (TRA-921). There is nowhere left to report to, so leave.
    if (isBrokenLogSink(err)) {
      process.exit(0);
    }
    logger.error(
      { err: formatErr(err), context },
      'Uncaught exception — server kept alive (safety net)',
    );
  });
}

/** Test-only: reset the install guard so a fresh import can re-register. */
export function __resetForTests(): void {
  installed = false;
}
