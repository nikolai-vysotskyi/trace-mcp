/**
 * TRA-2037: the 2026-09-28 silent death was a stall-watchdog SIGKILL
 * (`stalled` 00:26:16Z → `fatal` stallMs 180113 → launchd respawn) that the
 * telemetry counter recorded without a reason. These tests pin the last-will
 * diagnosis that now surfaces that breadcrumb at the next start.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateOomCrashFreshness,
  formatOomCrashes,
  formatStallAlerts,
  getStallAlertsPath,
  logUncleanStopDiagnosis,
  readRecentOomCrashes,
  readRecentOomCrashesWithDiagnostics,
  readRecentStallAlerts,
  summarizeStallAlerts,
} from '../unclean-stop.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import('../../logger.js');

function writeAlerts(lines: Array<Record<string, unknown> | string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-unclean-stop-'));
  const file = path.join(dir, 'stall-alerts.jsonl');
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
    'utf-8',
  );
  return file;
}

const STALLED_74842 = {
  time: '2026-09-28T00:26:16.925Z',
  pid: 74842,
  kind: 'stalled',
  stallMs: 10650,
  component: 'daemon',
};
const FATAL_74842 = {
  time: '2026-09-28T00:29:06.388Z',
  pid: 74842,
  kind: 'fatal',
  stallMs: 180113,
  component: 'daemon',
};

describe('getStallAlertsPath', () => {
  it('resolves the watchdog alert file inside the given index dir', () => {
    // path.join — never a '/' literal: the assertion must hold on Windows too.
    expect(getStallAlertsPath(path.join(os.tmpdir(), 'idx'))).toBe(
      path.join(os.tmpdir(), 'idx', 'stall-alerts.jsonl'),
    );
  });
});

describe('readRecentStallAlerts', () => {
  it('returns [] for a missing file instead of throwing', () => {
    expect(readRecentStallAlerts(path.join(os.tmpdir(), 'trace-no-such-file.jsonl'))).toEqual([]);
  });

  it('skips blank and torn lines, keeps the tail', () => {
    const file = writeAlerts([STALLED_74842, '{torn', '', FATAL_74842]);
    const tail = readRecentStallAlerts(file);
    expect(tail).toHaveLength(2);
    expect(tail[0]).toMatchObject({ pid: 74842, kind: 'stalled', stallMs: 10650 });
    expect(tail[1]).toMatchObject({ pid: 74842, kind: 'fatal', stallMs: 180113 });
  });

  it('caps the tail at maxLines', () => {
    const file = writeAlerts([STALLED_74842, FATAL_74842, STALLED_74842]);
    const tail = readRecentStallAlerts(file, 2);
    expect(tail).toHaveLength(2);
    expect(tail[0]).toMatchObject({ kind: 'fatal' });
    expect(tail[1]).toMatchObject({ kind: 'stalled' });
  });
});

describe('summarizeStallAlerts', () => {
  it('flags an unrecovered fatal — the TRA-2037 signature', () => {
    const summary = summarizeStallAlerts([STALLED_74842, FATAL_74842]);
    expect(summary.count).toBe(2);
    expect(summary.unrecoveredFatal).toEqual(FATAL_74842);
    expect(summary.lastFatal).toEqual(FATAL_74842);
  });

  it('does not flag a fatal followed by recovery', () => {
    const recovered = {
      time: '2026-09-28T00:30:00.000Z',
      pid: 94854,
      kind: 'recovered',
      stallMs: 340,
    };
    const summary = summarizeStallAlerts([FATAL_74842, recovered]);
    expect(summary.unrecoveredFatal).toBeUndefined();
    expect(summary.lastRecovered).toEqual(recovered);
  });

  it('summarizes an empty tail', () => {
    expect(summarizeStallAlerts([])).toEqual({ count: 0 });
  });
});

describe('formatStallAlerts', () => {
  it('stays quiet when there is nothing to say', () => {
    expect(formatStallAlerts({ count: 0 })).toEqual([]);
  });

  it('names the watchdog SIGKILL for an unrecovered fatal', () => {
    const lines = formatStallAlerts(summarizeStallAlerts([STALLED_74842, FATAL_74842]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('SIGKILL');
    expect(lines[0]).toContain('180113');
  });

  it('reports a recovered fatal without claiming a kill', () => {
    const recovered = {
      time: '2026-09-28T00:30:00.000Z',
      pid: 94854,
      kind: 'recovered',
      stallMs: 340,
    };
    const lines = formatStallAlerts(summarizeStallAlerts([FATAL_74842, recovered]));
    expect(lines.join(' ')).toContain('recovered');
    expect(lines.join(' ')).not.toContain('SIGKILL');
  });
});

describe('logUncleanStopDiagnosis', () => {
  it('attributes an unrecovered watchdog fatal as the likely cause', () => {
    vi.mocked(logger.warn).mockClear();
    logUncleanStopDiagnosis({
      daemonStarts: 5,
      daemonUncleanStops: 1,
      launchdExit: { exitCode: 9, runs: 13 },
      stallSummary: summarizeStallAlerts([STALLED_74842, FATAL_74842]),
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toContain('TRA-2037');
    expect(fields.daemonUncleanStops).toBe(1);
    expect(fields.launchdLastExit).toBe(9);
    expect(String(fields.likelyCause)).toContain('stall-watchdog');
    expect(fields.watchdogFatal).toEqual(FATAL_74842);
  });

  it('points at Jetsam/external kill when launchd saw SIGKILL but the watchdog never fired', () => {
    vi.mocked(logger.warn).mockClear();
    logUncleanStopDiagnosis({
      daemonStarts: 5,
      daemonUncleanStops: 1,
      launchdExit: { exitCode: 9 },
      stallSummary: summarizeStallAlerts([]),
    });
    const [fields] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(String(fields.likelyCause)).toContain('kill -9');
    expect(fields.watchdogFatal).toBeUndefined();
  });

  it('never throws when launchd has no record', () => {
    expect(() =>
      logUncleanStopDiagnosis({
        daemonStarts: 1,
        daemonUncleanStops: 1,
        launchdExit: null,
        stallSummary: summarizeStallAlerts([]),
      }),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('attributes a V8 OOM crash report as the likely cause (TRA-2056)', () => {
    vi.mocked(logger.warn).mockClear();
    logUncleanStopDiagnosis({
      daemonStarts: 10,
      daemonUncleanStops: 2,
      launchdExit: null,
      stallSummary: summarizeStallAlerts([]),
      oomCrash: {
        path: '/tmp/DiagnosticReports/node-2026-09-28-184029.ips',
        mtimeMs: 1,
        pid: 41711,
      },
    });
    const [fields] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(String(fields.likelyCause)).toContain('V8');
    expect(String(fields.likelyCause)).toContain('OOM');
    expect(fields.oomCrashPid).toBe(41711);
  });

  it('prioritizes unrecovered watchdog fatal over an OOM crash report (TRA-2443)', () => {
    vi.mocked(logger.warn).mockClear();
    logUncleanStopDiagnosis({
      daemonStarts: 10,
      daemonUncleanStops: 2,
      launchdExit: { exitCode: 9 },
      stallSummary: summarizeStallAlerts([STALLED_74842, FATAL_74842]),
      oomCrash: {
        path: '/tmp/DiagnosticReports/node-2026-10-10-041741.ips',
        mtimeMs: Date.now() - 5000,
        pid: 74842,
      },
    });
    const [fields] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(String(fields.likelyCause)).toContain('stall-watchdog SIGKILL');
    expect(fields.watchdogFatal).toEqual(FATAL_74842);
    expect(fields.correlatedOomCrash).toBe('/tmp/DiagnosticReports/node-2026-10-10-041741.ips');
  });

  it('records unmatched/stale OOM report without diagnosing V8 OOM (TRA-2443)', () => {
    vi.mocked(logger.warn).mockClear();
    logUncleanStopDiagnosis({
      daemonStarts: 10,
      daemonUncleanStops: 2,
      launchdExit: { exitCode: 9 },
      stallSummary: summarizeStallAlerts([]),
      oomCrash: null,
      staleOomCrash: {
        report: {
          path: '/tmp/DiagnosticReports/node-2026-10-10-041741.ips',
          mtimeMs: 1728533861000,
          pid: 41711,
        },
        reason: 'PID mismatch (report pid 41711 != target pid 8045)',
      },
      targetPid: 8045,
    });
    const [fields] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
    expect(String(fields.likelyCause)).not.toContain('V8');
    expect(fields.unmatchedOomReport).toBe('/tmp/DiagnosticReports/node-2026-10-10-041741.ips');
    expect(String(fields.unmatchedOomReason)).toContain('PID mismatch');
  });
});

describe('evaluateOomCrashFreshness (TRA-2443)', () => {
  const baseReport = {
    path: '/path/node.ips',
    mtimeMs: 1_000_000,
    pid: 1234,
  };

  it('rejects report when targetPid does not match report pid', () => {
    const verdict = evaluateOomCrashFreshness(baseReport, { targetPid: 5678, nowMs: 1_000_100 });
    expect(verdict.fresh).toBe(false);
    expect(verdict.reason).toContain('PID mismatch');
  });

  it('accepts report when targetPid matches', () => {
    const verdict = evaluateOomCrashFreshness(baseReport, { targetPid: 1234, nowMs: 1_000_100 });
    expect(verdict.fresh).toBe(true);
  });

  it('rejects report when mtime predates sinceMs', () => {
    const verdict = evaluateOomCrashFreshness(baseReport, {
      targetPid: 1234,
      sinceMs: 1_005_000,
      nowMs: 1_010_000,
    });
    expect(verdict.fresh).toBe(false);
    expect(verdict.reason).toContain('predates daemon run start');
  });

  it('accepts report when mtime is after sinceMs', () => {
    const verdict = evaluateOomCrashFreshness(baseReport, {
      targetPid: 1234,
      sinceMs: 995_000,
      nowMs: 1_005_000,
    });
    expect(verdict.fresh).toBe(true);
  });

  it('rejects report when older than maxAgeMs', () => {
    const verdict = evaluateOomCrashFreshness(baseReport, {
      maxAgeMs: 5_000,
      nowMs: 1_010_000,
    });
    expect(verdict.fresh).toBe(false);
    expect(verdict.reason).toContain('exceeds max age');
  });
});

describe('readRecentOomCrashes (TRA-2056, TRA-2443)', () => {
  function writeIps(dir: string, name: string, body: string, mtimeMs?: number): string {
    const full = path.join(dir, name);
    fs.writeFileSync(full, body, 'utf-8');
    if (mtimeMs !== undefined) {
      const timeSec = mtimeMs / 1000;
      fs.utimesSync(full, timeSec, timeSec);
    }
    return full;
  }

  it('returns [] for a missing dir instead of throwing', () => {
    expect(readRecentOomCrashes(path.join(os.tmpdir(), 'trace-no-such-dir-oom'))).toEqual([]);
  });

  it('matches the TRA-2056 signature and skips non-daemon reports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-oom-'));
    writeIps(
      dir,
      'node-2026-09-28-184029.ips',
      '{"coalitionName" : "com.trace-mcp.server", "pid" : 41711}\n' +
        'v8::internal::Heap::FatalProcessOutOfMemory node::OOMErrorHandler abort',
    );
    writeIps(dir, 'node-2026-09-28-190000.ips', '{"coalitionName" : "com.other.app"} SIGABRT');
    writeIps(dir, 'other.txt', 'coalitionName com.trace-mcp.server FatalProcessOutOfMemory');
    const found = readRecentOomCrashes(dir);
    expect(found).toHaveLength(1);
    expect(found[0].pid).toBe(41711);
    expect(found[0].path).toContain('node-2026-09-28-184029.ips');
    expect(formatOomCrashes(found)).toHaveLength(1);
    expect(formatOomCrashes(found)[0]).toContain('OOM');
    expect(formatOomCrashes([])).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('filters out stale reports and PID mismatches (TRA-2443)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-oom-tra2443-'));
    const now = 1_700_000_000_000;
    // Ancient report from 5 days ago with same PID (e.g. from a past incarnation)
    writeIps(
      dir,
      'node-2026-10-10-041741.ips',
      '{"coalitionName" : "com.trace-mcp.server", "pid" : 8045}\n' +
        'v8::internal::Heap::FatalProcessOutOfMemory node::OOMErrorHandler abort',
      now - 5 * 24 * 3600 * 1000,
    );
    // Unrelated PID report (like node-2026-10-15-043157.ips with PID 69245)
    writeIps(
      dir,
      'node-2026-10-15-043157.ips',
      '{"coalitionName" : "com.trace-mcp.server", "pid" : 69245}\n' +
        'v8::internal::Heap::FatalProcessOutOfMemory node::OOMErrorHandler abort',
      now - 60_000,
    );
    // Real fresh report matching our PID 8045
    writeIps(
      dir,
      'node-2026-10-15-041355.ips',
      '{"coalitionName" : "com.trace-mcp.server", "pid" : 8045}\n' +
        'v8::internal::Heap::FatalProcessOutOfMemory node::OOMErrorHandler abort',
      now - 30_000,
    );

    const result = readRecentOomCrashesWithDiagnostics({
      dirOverride: dir,
      targetPid: 8045,
      sinceMs: now - 300_000,
      nowMs: now,
    });

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].pid).toBe(8045);
    expect(result.matched[0].path).toContain('node-2026-10-15-041355.ips');

    expect(result.rejected).toHaveLength(2);
    const pidMismatch = result.rejected.find((r) => r.report.pid === 69245);
    expect(pidMismatch?.reason).toContain('PID mismatch');
    const staleReport = result.rejected.find((r) => r.report.path.includes('node-2026-10-10'));
    expect(staleReport?.reason).toContain('stale');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
