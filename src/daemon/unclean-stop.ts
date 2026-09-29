/**
 * Last-will diagnosis for unclean daemon stops (TRA-2037).
 *
 * Why this exists: a SIGKILL runs no JS — no `Daemon shutting down` line, no
 * TRA-1911 exit breadcrumb, no `.ips` — so the next boot only knew "the
 * previous run died" via the `daemonUncleanStops` counter, with no reason
 * attached. The one exception already proved the pattern: the stall watchdog's
 * worker thread survives a wedged main thread and appends a `fatal` line to
 * `stall-alerts.jsonl` before SIGKILLing the process (TRA-1957) — but nothing
 * ever read that file back, so the 2026-09-28 death looked causeless until a
 * human grepped it by hand (`stalled` 00:26:16Z → `fatal` stallMs 180113 →
 * launchd respawn 19 s later).
 *
 * On every unclean start the daemon now logs one warn carrying everything
 * knowable post-mortem — telemetry counters, launchd's last-exit record, and
 * the tail of the watchdog alert file — and `daemon status` prints the same
 * tail. What is genuinely unknowable after a SIGKILL (the dead process's heap,
 * in-flight reindex set) is NOT reconstructed here: the per-minute vitals line
 * in daemon.log is that trajectory, and this module points at it instead of
 * duplicating it.
 *
 * All readers are best-effort and never throw: attribution must not break boot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { INDEX_DIR } from '../shared/paths.js';
import type { LaunchdLastExit } from './lifecycle.js';

/** Watchdog alert file name inside INDEX_DIR (cf. serve-http's StallWatchdog). */
export const STALL_ALERTS_FILENAME = 'stall-alerts.jsonl';

/** Absolute path of the watchdog alert file. Injectable for tests. */
export function getStallAlertsPath(indexDir: string = INDEX_DIR): string {
  return path.join(indexDir, STALL_ALERTS_FILENAME);
}

/** One parsed watchdog alert line. Unknown shapes are dropped by the reader. */
export interface StallAlert {
  time?: string;
  pid?: number;
  kind?: string;
  stallMs?: number;
}

/**
 * Best-effort tail of the watchdog alert file: the most recent `maxLines`
 * parseable JSONL entries, oldest first. [] when the file is absent,
 * unreadable, or holds nothing parseable.
 */
export function readRecentStallAlerts(
  alertFile: string = getStallAlertsPath(),
  maxLines = 10,
): StallAlert[] {
  let text: string;
  try {
    text = fs.readFileSync(alertFile, 'utf-8');
  } catch {
    return [];
  }
  const out: StallAlert[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<StallAlert>;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const alert: StallAlert = {};
      if (typeof parsed.time === 'string') alert.time = parsed.time;
      if (typeof parsed.pid === 'number') alert.pid = parsed.pid;
      if (typeof parsed.kind === 'string') alert.kind = parsed.kind;
      if (typeof parsed.stallMs === 'number') alert.stallMs = parsed.stallMs;
      out.push(alert);
    } catch {
      /* a torn write from a dying worker is evidence too — just not parseable */
    }
  }
  return out.slice(-Math.max(1, maxLines));
}

export interface StallAlertSummary {
  /** Parseable entries in the tail read. */
  count: number;
  lastFatal?: StallAlert;
  lastStalled?: StallAlert;
  lastRecovered?: StallAlert;
  /**
   * A `fatal` with no later `recovered` — the previous run was SIGKILLed by
   * its own stall watchdog after `fatalAfterMs` without an event-loop beat.
   * This is the attributed cause, not a guess.
   */
  unrecoveredFatal?: StallAlert;
}

/** Reduce a tail to the latest entry per kind + the unrecovered-fatal verdict. */
export function summarizeStallAlerts(alerts: StallAlert[]): StallAlertSummary {
  const summary: StallAlertSummary = { count: alerts.length };
  for (const alert of alerts) {
    if (alert.kind === 'fatal') summary.lastFatal = alert;
    else if (alert.kind === 'stalled') summary.lastStalled = alert;
    else if (alert.kind === 'recovered') summary.lastRecovered = alert;
  }
  if (summary.lastFatal) {
    const fatalIdx = alerts.lastIndexOf(summary.lastFatal);
    const recoveredAfter = alerts.slice(fatalIdx + 1).some((a) => a.kind === 'recovered');
    if (!recoveredAfter) summary.unrecoveredFatal = summary.lastFatal;
  }
  return summary;
}

/**
 * Human-readable lines for `daemon status`. [] when the tail says nothing —
 * status stays quiet on healthy installs.
 */
export function formatStallAlerts(summary: StallAlertSummary): string[] {
  if (summary.count === 0) return [];
  const lines: string[] = [];
  const fmt = (a: StallAlert): string =>
    [a.time ?? '?', a.pid !== undefined ? `pid ${a.pid}` : null, `stall ${a.stallMs ?? '?'}ms`]
      .filter((p): p is string => p !== null)
      .join(', ');
  if (summary.unrecoveredFatal) {
    lines.push(
      `  Stall watchdog: previous run SIGKILLed after a hard stall (${fmt(summary.unrecoveredFatal)})`,
    );
  } else if (summary.lastFatal) {
    lines.push(`  Stall watchdog: last fatal stall recovered since (${fmt(summary.lastFatal)})`);
  } else if (summary.lastStalled) {
    lines.push(`  Stall watchdog: last stall (recovered): ${fmt(summary.lastStalled)}`);
  }
  return lines;
}

export interface UncleanStopDiagnosis {
  daemonStarts: number;
  daemonUncleanStops: number;
  launchdExit: LaunchdLastExit | null;
  stallSummary: StallAlertSummary;
}

/**
 * One warn at (unclean) startup so the death is visible in daemon.log itself,
 * next to the launchd post-mortem (`logPreviousExit`) — not just as a silent
 * counter increment. Never throws.
 */
export function logUncleanStopDiagnosis(diagnosis: UncleanStopDiagnosis): void {
  try {
    const { daemonStarts, daemonUncleanStops, launchdExit, stallSummary } = diagnosis;
    const fields: Record<string, unknown> = {
      daemonStarts,
      daemonUncleanStops,
      stallAlertFile: getStallAlertsPath(),
      stallAlertsSeen: stallSummary.count,
    };
    if (launchdExit) {
      if (launchdExit.exitCode !== undefined) fields.launchdLastExit = launchdExit.exitCode;
      if (launchdExit.reason !== undefined) fields.launchdLastExitReason = launchdExit.reason;
      if (launchdExit.runs !== undefined) fields.launchdRuns = launchdExit.runs;
    }
    if (stallSummary.unrecoveredFatal) {
      fields.watchdogFatal = stallSummary.unrecoveredFatal;
      fields.likelyCause = 'stall-watchdog SIGKILL after fatalAfterMs without an event-loop beat';
    } else {
      if (stallSummary.lastFatal) fields.lastFatalStall = stallSummary.lastFatal;
      if (stallSummary.lastStalled) fields.lastStall = stallSummary.lastStalled;
      if (launchdExit?.exitCode === 9 && !stallSummary.unrecoveredFatal) {
        fields.likelyCause =
          'SIGKILL with no watchdog fatal — OS memory kill (Jetsam/OOM) or external kill -9; ' +
          'see daemon.log vitals trajectory before the gap';
      }
    }
    logger.warn(
      fields,
      'Previous daemon run ended without a clean shutdown — last-will diagnosis (TRA-2037)',
    );
  } catch {
    /* attribution must never break boot */
  }
}
