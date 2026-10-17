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
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger.js';
import { INDEX_DIR } from '../shared/paths.js';
import type { LaunchdLastExit } from './lifecycle.js';

/** Watchdog alert file name inside INDEX_DIR (cf. serve-http's StallWatchdog). */
export const STALL_ALERTS_FILENAME = 'stall-alerts.jsonl';

/** Coalition name launchd assigns the daemon (cf. the TRA-2056 .ips report). */
export const DAEMON_COALITION_NAME = 'com.trace-mcp.server';

/** macOS DiagnosticReports dir holding node-*.ips crash reports. Null elsewhere. */
export function getOomCrashReportDir(
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string | null {
  if (platform !== 'darwin') return null;
  return path.join(homeDir, 'Library', 'Logs', 'DiagnosticReports');
}

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

export interface OomCrashReport {
  /** Absolute path of the .ips report. */
  path: string;
  /** Report mtime (epoch ms) — orders the crash against the daemon.log gap. */
  mtimeMs: number;
  /** Crashed pid parsed from the report, when present. */
  pid?: number;
}

export interface ReadOomCrashesOptions {
  /** Directory containing .ips crash reports (defaults to DiagnosticReports). */
  dirOverride?: string;
  /** Max reports to return. Default 3. */
  maxReports?: number;
  /**
   * Expected crashed process PID (TRA-2443).
   * Reports containing a parsed "pid" that differs from targetPid are rejected.
   */
  targetPid?: number;
  /**
   * Minimum timestamp in epoch ms (TRA-2443).
   * Reports modified earlier than this are rejected as stale.
   */
  sinceMs?: number;
  /**
   * Max age in ms relative to now (TRA-2443).
   * Reports older than maxAgeMs are rejected as stale.
   */
  maxAgeMs?: number;
  /** Injectable current time for testing. */
  nowMs?: number;
}

export interface OomCrashEvaluation {
  fresh: boolean;
  reason: string;
}

/**
 * Verify if an OOM crash report is fresh and correlates with the failed daemon run (TRA-2443).
 *
 * A crash report from days ago or with a different PID must never be attributed as
 * the cause of an unclean stop.
 */
export function evaluateOomCrashFreshness(
  report: OomCrashReport,
  options: {
    targetPid?: number;
    sinceMs?: number;
    maxAgeMs?: number;
    nowMs?: number;
  } = {},
): OomCrashEvaluation {
  const now = options.nowMs ?? Date.now();
  if (
    options.targetPid !== undefined &&
    report.pid !== undefined &&
    report.pid !== options.targetPid
  ) {
    return {
      fresh: false,
      reason: `PID mismatch (report pid ${report.pid} != target pid ${options.targetPid})`,
    };
  }
  if (options.sinceMs !== undefined && report.mtimeMs < options.sinceMs) {
    const diffSec = Math.round((options.sinceMs - report.mtimeMs) / 1000);
    return {
      fresh: false,
      reason: `stale: report mtime predates daemon run start by ${diffSec}s`,
    };
  }
  const maxAge =
    options.maxAgeMs ??
    (options.sinceMs !== undefined || options.targetPid !== undefined
      ? undefined
      : 24 * 60 * 60 * 1000);
  if (maxAge !== undefined && now - report.mtimeMs > maxAge) {
    const ageHours = Math.round((now - report.mtimeMs) / (3600 * 1000));
    return {
      fresh: false,
      reason: `stale: report is ${ageHours}h old (exceeds max age of ${Math.round(maxAge / 3600000)}h)`,
    };
  }
  return { fresh: true, reason: 'matched target PID and recent time window' };
}

export interface OomCrashesWithDiagnostics {
  matched: OomCrashReport[];
  rejected: Array<{ report: OomCrashReport; reason: string }>;
}

/**
 * Scan for V8 heap-OOM crash reports with full match diagnostics (TRA-2443).
 */
export function readRecentOomCrashesWithDiagnostics(
  dirOverrideOrOptions?: string | ReadOomCrashesOptions,
  legacyMaxReports = 3,
): OomCrashesWithDiagnostics {
  let dirOverride: string | undefined;
  let maxReports = legacyMaxReports;
  let targetPid: number | undefined;
  let sinceMs: number | undefined;
  let maxAgeMs: number | undefined;
  let nowMs: number | undefined;

  if (typeof dirOverrideOrOptions === 'string') {
    dirOverride = dirOverrideOrOptions;
  } else if (dirOverrideOrOptions && typeof dirOverrideOrOptions === 'object') {
    dirOverride = dirOverrideOrOptions.dirOverride;
    maxReports = dirOverrideOrOptions.maxReports ?? legacyMaxReports;
    targetPid = dirOverrideOrOptions.targetPid;
    sinceMs = dirOverrideOrOptions.sinceMs;
    maxAgeMs = dirOverrideOrOptions.maxAgeMs;
    nowMs = dirOverrideOrOptions.nowMs;
  }

  let dir: string | null = null;
  try {
    dir = dirOverride ?? getOomCrashReportDir();
  } catch {
    return { matched: [], rejected: [] };
  }
  if (!dir) return { matched: [], rejected: [] };
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith('node-') && n.endsWith('.ips'));
  } catch {
    return { matched: [], rejected: [] };
  }
  if (names.length === 0) return { matched: [], rejected: [] };
  const MAX_IPS_BYTES = 512 * 1024;
  const withMtime: Array<{ name: string; mtimeMs: number }> = [];
  for (const name of names) {
    try {
      const st = fs.statSync(path.join(dir, name));
      withMtime.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      /* a racing log-rotation unlink is not evidence */
    }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const matched: OomCrashReport[] = [];
  const rejected: Array<{ report: OomCrashReport; reason: string }> = [];

  for (const { name, mtimeMs } of withMtime.slice(0, 20)) {
    if (matched.length >= Math.max(1, maxReports)) break;
    const full = path.join(dir, name);
    let text: string;
    try {
      const fd = fs.openSync(full, 'r');
      try {
        const st = fs.fstatSync(fd);
        const len = Math.min(st.size, MAX_IPS_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, 0);
        text = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    if (!text.includes(DAEMON_COALITION_NAME)) continue;
    if (!text.includes('FatalProcessOutOfMemory') && !text.includes('OOMErrorHandler')) continue;
    const report: OomCrashReport = { path: full, mtimeMs };
    const pidMatch = text.match(/"pid"\s*:\s*(\d+)/);
    if (pidMatch) {
      const pid = Number.parseInt(pidMatch[1], 10);
      if (Number.isFinite(pid)) report.pid = pid;
    }

    const evaluation = evaluateOomCrashFreshness(report, {
      targetPid,
      sinceMs,
      maxAgeMs,
      nowMs,
    });
    if (evaluation.fresh) {
      matched.push(report);
    } else {
      rejected.push({ report, reason: evaluation.reason });
    }
  }
  return { matched, rejected };
}

/**
 * Best-effort scan for a V8 heap-OOM crash report from the previous daemon
 * run (TRA-2056, TRA-2443).
 *
 * A V8 OOM aborts via `V8::FatalProcessOutOfMemory` → SIGABRT — no JS
 * shutdown handler runs, so daemon.log holds only the vitals trajectory
 * before the gap. macOS writes a `node-*.ips` report whose faulting stack
 * names `FatalProcessOutOfMemory`/`OOMErrorHandler` under the daemon's
 * coalition (`com.trace-mcp.server`).
 *
 * TRA-2443: Stale reports or reports for different PIDs are rejected rather
 * than falsely diagnosed as the cause of this stop.
 *
 * Returns matches newest-first, capped at `maxReports`; [] when the dir is
 * absent, unreadable, or holds nothing matching (including all non-darwin
 * platforms). Reads are capped (`MAX_IPS_BYTES`) and never throw.
 */
export function readRecentOomCrashes(
  dirOverrideOrOptions?: string | ReadOomCrashesOptions,
  maxReports = 3,
): OomCrashReport[] {
  return readRecentOomCrashesWithDiagnostics(dirOverrideOrOptions, maxReports).matched;
}

/**
 * Human-readable lines for `daemon status`. [] when no OOM report matches —
 * status stays quiet on healthy installs.
 */
export function formatOomCrashes(reports: OomCrashReport[]): string[] {
  if (reports.length === 0) return [];
  const latest = reports[0];
  const when = new Date(latest.mtimeMs).toISOString();
  return [
    `  V8 heap OOM crash report: ${latest.path} (${when}` +
      (latest.pid !== undefined ? `, pid ${latest.pid}` : '') +
      ')',
  ];
}

export interface UncleanStopDiagnosis {
  daemonStarts: number;
  daemonUncleanStops: number;
  launchdExit: LaunchdLastExit | null;
  stallSummary: StallAlertSummary;
  oomCrash?: OomCrashReport | null;
  staleOomCrash?: { report: OomCrashReport; reason: string } | null;
  targetPid?: number;
  previousStartedAt?: number;
}

/**
 * One warn at (unclean) startup so the death is visible in daemon.log itself,
 * next to the launchd post-mortem (`logPreviousExit`) — not just as a silent
 * counter increment. Never throws.
 */
export function logUncleanStopDiagnosis(diagnosis: UncleanStopDiagnosis): void {
  try {
    const {
      daemonStarts,
      daemonUncleanStops,
      launchdExit,
      stallSummary,
      oomCrash,
      staleOomCrash,
      targetPid,
      previousStartedAt,
    } = diagnosis;
    const fields: Record<string, unknown> = {
      daemonStarts,
      daemonUncleanStops,
      stallAlertFile: getStallAlertsPath(),
      stallAlertsSeen: stallSummary.count,
    };
    if (targetPid !== undefined) fields.targetPid = targetPid;
    if (previousStartedAt !== undefined) fields.previousStartedAt = previousStartedAt;
    if (oomCrash) {
      fields.oomCrashReport = oomCrash.path;
      if (oomCrash.pid !== undefined) fields.oomCrashPid = oomCrash.pid;
    }
    if (staleOomCrash) {
      fields.unmatchedOomReport = staleOomCrash.report.path;
      fields.unmatchedOomReason = staleOomCrash.reason;
    }
    if (launchdExit) {
      if (launchdExit.exitCode !== undefined) fields.launchdLastExit = launchdExit.exitCode;
      if (launchdExit.reason !== undefined) fields.launchdLastExitReason = launchdExit.reason;
      if (launchdExit.runs !== undefined) fields.launchdRuns = launchdExit.runs;
    }
    // TRA-2443: stallSummary.unrecoveredFatal is direct, definitive evidence
    // from the stall watchdog worker thread that it sent SIGKILL to this process.
    // It must take precedence over circumstantial filesystem scans, and old
    // OOM reports must never override an unrecovered watchdog kill or be attributed
    // without matching PID/time.
    if (stallSummary.unrecoveredFatal) {
      fields.watchdogFatal = stallSummary.unrecoveredFatal;
      fields.likelyCause = 'stall-watchdog SIGKILL after fatalAfterMs without an event-loop beat';
      if (oomCrash) {
        fields.correlatedOomCrash = oomCrash.path;
      }
    } else if (oomCrash) {
      fields.likelyCause =
        'V8 JavaScript heap OOM (FatalProcessOutOfMemory in the crash report; ' +
        'see daemon.log Daemon vitals heap_used_mb trajectory before the gap)';
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
