/**
 * Synchronous exit breadcrumb for the long-lived daemon (TRA-1911).
 *
 * Why this exists: the daemon restarted ~hourly for 30 h (37 starts, 32 deaths
 * with no `Daemon shutdown complete` line). Every death log goes through pino,
 * which buffers asynchronously — a `logger.info()` immediately followed by
 * `process.exit()` (EADDRINUSE, httpServer error, the `httpServer.close()`
 * callback, the broken-pipe guard) can lose its line, and a SIGHUP arrived with
 * no handler at all, so the process died without a word. A SIGKILL still runs
 * no JS, but everything else now leaves one synchronous line behind.
 *
 * The breadcrumb is written with `fs.appendFileSync` inside a `process.on('exit')`
 * handler — the only thing that is guaranteed to run on a `process.exit()` path.
 * It is deliberately pino-shaped NDJSON so it greps exactly like the rest of
 * daemon.log. Best-effort throughout: a failed append must never break shutdown.
 */
import fs from 'node:fs';
import { DAEMON_LOG_PATH } from '../global.js';

/** Last shutdown reason recorded via `noteDaemonShutdownReason`, if any. */
let shutdownReason: string | null = null;

/**
 * Remember why the daemon is going down. Call synchronously at the top of every
 * shutdown path (signal handlers, idle-exit, version-staleness, bind-race exits)
 * so the `exit` handler — which runs later and receives only a numeric code —
 * can attribute the death.
 */
export function noteDaemonShutdownReason(reason: string): void {
  shutdownReason = reason;
}

/** Build the breadcrumb record. Pure apart from cheap process introspection. */
export function buildExitBreadcrumb(exitCode: number | null): Record<string, unknown> {
  let rssMb = 0;
  try {
    rssMb = Math.round(process.memoryUsage.rss() / 1024 / 1024);
  } catch {
    /* unreadable — report zero rather than skip the breadcrumb */
  }
  return {
    level: 30,
    time: Date.now(),
    pid: process.pid,
    name: 'trace-mcp',
    exitCode,
    shutdownReason,
    uptimeSec: Math.floor(process.uptime()),
    rssMb,
    msg: 'Daemon exit (sync breadcrumb)',
  };
}

/**
 * Append one breadcrumb record to daemon.log, synchronously. Never throws —
 * logging must not break shutdown, and the `exit` handler has no async option.
 */
export function writeExitBreadcrumbSync(
  logPath: string = DAEMON_LOG_PATH,
  record: Record<string, unknown> = buildExitBreadcrumb(null),
): void {
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    /* log attribution is best-effort */
  }
}

let installed = false;
let onExit: ((code: number) => void) | null = null;

/**
 * Install the synchronous `exit` breadcrumb. Idempotent — safe to call from
 * multiple entry points. Returns an uninstall handle (used by tests).
 */
export function installDaemonExitBreadcrumb(): () => void {
  if (installed) return () => {};
  installed = true;
  onExit = (code: number) => {
    writeExitBreadcrumbSync(DAEMON_LOG_PATH, buildExitBreadcrumb(code));
  };
  process.once('exit', onExit);
  return () => {
    if (onExit) process.removeListener('exit', onExit);
    onExit = null;
    installed = false;
  };
}

/** Test-only: clear the recorded reason and the install guard. */
export function __resetExitBreadcrumbForTests(): void {
  shutdownReason = null;
  if (onExit) process.removeListener('exit', onExit);
  onExit = null;
  installed = false;
}
