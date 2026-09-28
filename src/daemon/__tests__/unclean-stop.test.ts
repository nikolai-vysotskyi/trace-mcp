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
  formatStallAlerts,
  getStallAlertsPath,
  logUncleanStopDiagnosis,
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
    expect(getStallAlertsPath('/tmp/idx')).toBe('/tmp/idx/stall-alerts.jsonl');
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
});
