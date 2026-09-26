import fs from 'node:fs';

/**
 * Record in daemon.log that this process is about to stop the daemon (TRA-850).
 *
 * The postinstall scripts kill the running daemon — `launchctl stop`,
 * `bootout`, `kickstart -k` — and their own `log()` output goes to the install
 * transcript, which nobody correlates with daemon.log afterwards. From
 * daemon.log's side the stop appeared as a bare `reason: SIGTERM` with no
 * initiator: 27 of 34 stops in one field day had no recorded source.
 *
 * Writes the same pino-shaped NDJSON record `src/daemon/lifecycle.ts` writes,
 * so `Daemon <action> requested` lines read alike whoever produced them.
 * Best-effort: a failed append must never fail an install.
 *
 * @param {string} logPath Absolute path to daemon.log.
 * @param {string} action What we are about to do, e.g. 'bootout', 'stop'.
 * @param {string} via Which code path asked for it.
 * @param {Record<string, unknown>} [extra] Extra fields merged into the record —
 *   postinstall passes `requesterArgs`, `candidateVersion`, `currentVersion`
 *   and `pkgRoot` (TRA-1963/TRA-1954) so a stop can be told apart from every
 *   other initiator without correlating a second log file.
 */
export function logDaemonStopAttribution(logPath, action, via, extra = {}) {
  try {
    const record = {
      level: 30,
      time: Date.now(),
      pid: process.pid,
      name: 'trace-mcp',
      action,
      via,
      requesterPid: process.pid,
      requesterPpid: process.ppid,
      ...extra,
      managedBy: 'postinstall',
      msg: `Daemon ${action} requested`,
    };
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    /* attribution is best-effort */
  }
}
