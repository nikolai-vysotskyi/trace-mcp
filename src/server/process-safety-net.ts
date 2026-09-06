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
 * True when an error *raised by process.stdout or process.stderr* means that
 * sink is gone for good: the pipe's reader has closed. Only ever consulted for
 * errors emitted by those two streams, so the code alone is enough — the same
 * code arriving from an HTTP response or any other socket never reaches here.
 */
export function isBrokenPipe(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
  );
}

/**
 * Guard the two streams the logger writes to.
 *
 * When the parent that owned our stdout/stderr pipe exits without killing us,
 * every write to it fails with EPIPE, emitted as an `error` event on the stream.
 * With no listener that becomes an uncaught exception — and the safety net below
 * answers an uncaught exception by *logging*, to the same dead pipe, which fails
 * again, forever. A leaked `serve-http` was measured that way at 97% of a core
 * and 517 MB with zero clients, 5h56m after its parent exited (TRA-921).
 *
 * Listening here is what makes the decision provable: the error is known to
 * belong to stdout/stderr because the stream itself emitted it. A broken pipe
 * means there is nowhere left to report to, so the process leaves. Any other
 * write failure (ENOSPC, EACCES) is swallowed — a logger must not take the
 * server down, which is the same call `attachFileLogging` makes for its own
 * stream.
 */
function guardLogSinks(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (isBrokenPipe(err)) {
        process.exit(0);
      }
    });
  }
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
    logger.error(
      { err: formatErr(err), context },
      'Uncaught exception — server kept alive (safety net)',
    );
  });

  guardLogSinks();
}

/** Test-only: reset the install guard so a fresh import can re-register. */
export function __resetForTests(): void {
  installed = false;
}
