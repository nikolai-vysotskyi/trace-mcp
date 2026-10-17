import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  evaluateOomCrashFreshness,
  logUncleanStopDiagnosis,
  readRecentOomCrashesWithDiagnostics,
  summarizeStallAlerts,
} from '../../src/daemon/unclean-stop.js';
import {
  readDaemonReliabilityCounters,
  recordDaemonCleanStop,
  recordDaemonStart,
} from '../../src/telemetry/usage-ping.js';
import {
  getProject,
  listProjects,
  registerProject,
  unregisterProject,
} from '../../src/registry.js';
import { REGISTRY_PATH } from '../../src/global.js';

vi.mock('../../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import('../../src/logger.js');

describe('TRA-2443: daemon disappearance correlation and crash report freshness', () => {
  let tmpDir: string;
  let oomReportsDir: string;
  let isolatedDataDir: string;
  let testProjectRoot: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tra2443-test-'));
    oomReportsDir = path.join(tmpDir, 'DiagnosticReports');
    isolatedDataDir = path.join(tmpDir, 'isolated-data');
    testProjectRoot = path.join(tmpDir, 'test-project');

    fs.mkdirSync(oomReportsDir, { recursive: true });
    fs.mkdirSync(isolatedDataDir, { recursive: true });
    fs.mkdirSync(testProjectRoot, { recursive: true });
    fs.writeFileSync(path.join(testProjectRoot, 'package.json'), '{"name":"test-project"}');
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('exact reproduction of 2026-10-15 disappearances (PID 8045 and PID 35894)', () => {
    const t0 = 1_792_022_400_000; // Reference time base (2026-10-15 00:00:00 UTC)

    // Stall watchdog fatal alerts recorded in stall-alerts.jsonl
    const FATAL_ALERT_8045 = {
      time: '2026-10-15T00:13:55.906Z',
      pid: 8045,
      kind: 'fatal',
      stallMs: 180714,
      component: 'daemon',
    };

    const FATAL_ALERT_35894 = {
      time: '2026-10-15T00:25:41.521Z',
      pid: 35894,
      kind: 'fatal',
      stallMs: 180991,
      component: 'daemon',
    };

    it('rejects stale Oct 10 report and unrelated Oct 15 PID 69245 report for PID 8045', () => {
      // 1. node-2026-10-10-041741.ips from 5 days earlier (PID 41711)
      const oct10File = path.join(oomReportsDir, 'node-2026-10-10-041741.ips');
      fs.writeFileSync(
        oct10File,
        '{"coalitionName" : "com.trace-mcp.server", "pid" : 41711}\n' +
          'v8::internal::Heap::FatalProcessOutOfMemory node::OOMErrorHandler abort',
      );
      const oct10Time = (t0 - 5 * 24 * 3600 * 1000) / 1000;
      fs.utimesSync(oct10File, oct10Time, oct10Time);

      // 2. node-2026-10-15-043157.ips with unrelated PID 69245
      const oct15File = path.join(oomReportsDir, 'node-2026-10-15-043157.ips');
      fs.writeFileSync(
        oct15File,
        '{"coalitionName" : "com.trace-mcp.server", "pid" : 69245}\n' +
          'v8::internal::Heap::FatalProcessOutOfMemory node::OOMErrorHandler abort',
      );
      const oct15Time = (t0 + 31 * 60 * 1000) / 1000;
      fs.utimesSync(oct15File, oct15Time, oct15Time);

      // Simulate PID 8045 unclean stop diagnosis at ~00:15:34
      const diag8045 = readRecentOomCrashesWithDiagnostics({
        dirOverride: oomReportsDir,
        targetPid: 8045,
        sinceMs: t0 + 6 * 60 * 1000, // PID 8045 started at 00:06:12
        nowMs: t0 + 15 * 60 * 1000,
      });

      expect(diag8045.matched).toHaveLength(0);
      expect(diag8045.rejected).toHaveLength(2);

      const pidMismatch = diag8045.rejected.find((r) => r.report.pid === 69245);
      expect(pidMismatch?.reason).toContain('PID mismatch');

      const staleReport = diag8045.rejected.find((r) => r.report.pid === 41711);
      expect(staleReport?.reason).toContain('PID mismatch');

      // Verify logUncleanStopDiagnosis accurately attributes watchdog fatal
      vi.mocked(logger.warn).mockClear();
      logUncleanStopDiagnosis({
        daemonStarts: 2,
        daemonUncleanStops: 1,
        launchdExit: { exitCode: 9 },
        stallSummary: summarizeStallAlerts([FATAL_ALERT_8045]),
        oomCrash: diag8045.matched[0] ?? null,
        staleOomCrash: diag8045.rejected[0] ?? null,
        targetPid: 8045,
        previousStartedAt: t0 + 6 * 60 * 1000,
      });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [fields] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
      expect(String(fields.likelyCause)).toBe(
        'stall-watchdog SIGKILL after fatalAfterMs without an event-loop beat',
      );
      expect(fields.watchdogFatal).toEqual(FATAL_ALERT_8045);
      expect(fields.oomCrashReport).toBeUndefined();
      expect(fields.unmatchedOomReport).toBeDefined();
    });

    it('rejects stale reports and attributes watchdog fatal for PID 35894', () => {
      // Simulate PID 35894 unclean stop diagnosis at ~00:26:00
      const diag35894 = readRecentOomCrashesWithDiagnostics({
        dirOverride: oomReportsDir,
        targetPid: 35894,
        sinceMs: t0 + 14 * 60 * 1000, // PID 35894 started at 00:14:07
        nowMs: t0 + 26 * 60 * 1000,
      });

      expect(diag35894.matched).toHaveLength(0);

      vi.mocked(logger.warn).mockClear();
      logUncleanStopDiagnosis({
        daemonStarts: 3,
        daemonUncleanStops: 2,
        launchdExit: { exitCode: 9 },
        stallSummary: summarizeStallAlerts([FATAL_ALERT_35894]),
        oomCrash: diag35894.matched[0] ?? null,
        staleOomCrash: diag35894.rejected[0] ?? null,
        targetPid: 35894,
        previousStartedAt: t0 + 14 * 60 * 1000,
      });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [fields] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
      expect(String(fields.likelyCause)).toBe(
        'stall-watchdog SIGKILL after fatalAfterMs without an event-loop beat',
      );
      expect(fields.watchdogFatal).toEqual(FATAL_ALERT_35894);
    });
  });

  describe('fresh OOM report with matching PID and timeframe', () => {
    it('correctly attributes V8 heap OOM when PID and timeframe match and no watchdog fatal exists', () => {
      const now = 1_792_050_000_000;
      const freshOomFile = path.join(oomReportsDir, 'node-2026-10-15-120000.ips');
      fs.writeFileSync(
        freshOomFile,
        '{"coalitionName" : "com.trace-mcp.server", "pid" : 55555}\n' +
          'v8::internal::Heap::FatalProcessOutOfMemory node::OOMErrorHandler abort',
      );
      const freshTime = (now - 10_000) / 1000;
      fs.utimesSync(freshOomFile, freshTime, freshTime);

      const diag = readRecentOomCrashesWithDiagnostics({
        dirOverride: oomReportsDir,
        targetPid: 55555,
        sinceMs: now - 60_000,
        nowMs: now,
      });

      expect(diag.matched).toHaveLength(1);
      expect(diag.matched[0].pid).toBe(55555);

      vi.mocked(logger.warn).mockClear();
      logUncleanStopDiagnosis({
        daemonStarts: 4,
        daemonUncleanStops: 3,
        launchdExit: { exitCode: 6 }, // SIGABRT
        stallSummary: summarizeStallAlerts([]),
        oomCrash: diag.matched[0],
        targetPid: 55555,
        previousStartedAt: now - 60_000,
      });

      const [fields] = vi.mocked(logger.warn).mock.calls[0] as [Record<string, unknown>, string];
      expect(String(fields.likelyCause)).toContain('V8 JavaScript heap OOM');
      expect(fields.oomCrashPid).toBe(55555);
      expect(fields.oomCrashReport).toBe(freshOomFile);
    });
  });

  describe('isolated profile and registry test-root lifecycle (/tmp only)', () => {
    it('manages project registration and DELETE cleanly in an isolated registry', () => {
      // Register test project in /tmp
      registerProject(testProjectRoot, { name: 'test-project' });
      const entry = getProject(testProjectRoot);
      expect(entry).not.toBeNull();
      expect(entry?.name).toBe('test-project');

      // Verify registry contains project
      const registered = listProjects();
      expect(registered.some((p) => p.name === 'test-project')).toBe(true);

      // DELETE test root from registry
      unregisterProject(testProjectRoot);

      // Verify registry is now clean
      expect(getProject(testProjectRoot)).toBeNull();
      const remaining = listProjects();
      expect(remaining.some((p) => p.name === 'test-project')).toBe(false);
    });
  });
});
