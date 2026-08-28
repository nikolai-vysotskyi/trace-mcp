/**
 * TRA-267: the daemon exited twice with nothing in daemon.log. These are the
 * two breadcrumbs that make the next such exit diagnosable — a periodic vitals
 * line, and launchd's record of how the previous run ended.
 */
import { describe, expect, it, vi } from 'vitest';
import { formatLaunchdLastExit, parseLaunchdLastExit } from '../lifecycle.js';
import { buildVitals, startVitalsLog } from '../vitals-log.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { logger } = await import('../../logger.js');

describe('parseLaunchdLastExit', () => {
  it('reads a signalled death from `last exit code`', () => {
    const out = [
      'com.trace-mcp.server = {',
      '\tactive count = 0',
      '\tstate = not running',
      '\truns = 4',
      '\tlast exit code = 9',
      '}',
    ].join('\n');
    expect(parseLaunchdLastExit(out)).toEqual({ exitCode: 9, runs: 4 });
  });

  it('accepts the older `last exit status` spelling and a reason line', () => {
    const out = '\tlast exit status = 1\n\tlast exit reason = Killed: 9\n';
    expect(parseLaunchdLastExit(out)).toEqual({ exitCode: 1, reason: 'Killed: 9' });
  });

  it('returns an empty record when launchd printed nothing useful', () => {
    expect(parseLaunchdLastExit('state = running\n')).toEqual({});
  });
});

describe('formatLaunchdLastExit', () => {
  it('flags a SIGKILL-shaped exit code — the fingerprint of an OS memory kill', () => {
    const lines = formatLaunchdLastExit({ exitCode: 9, runs: 4 });
    expect(lines[0]).toContain('code 9');
    expect(lines[0]).toContain('SIGKILL');
    expect(lines).toContain('  launchd start count: 4');
  });

  it('does not add a signal hint to a clean exit', () => {
    expect(formatLaunchdLastExit({ exitCode: 0 })).toEqual(['  Last exit (launchd): code 0']);
  });

  it('says nothing when there is no record', () => {
    expect(formatLaunchdLastExit(null)).toEqual([]);
  });
});

describe('vitals log', () => {
  it('reports memory and project counts', () => {
    const v = buildVitals({ loaded: 45, indexing: 39 });
    expect(v.projects_loaded).toBe(45);
    expect(v.projects_indexing).toBe(39);
    expect(v.rss_mb).toBeGreaterThan(0);
    expect(v.heap_used_mb).toBeGreaterThan(0);
    expect(v.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('emits immediately and on every interval tick, and stops on demand', () => {
    vi.useFakeTimers();
    vi.mocked(logger.info).mockClear();
    const stop = startVitalsLog({
      getCounts: () => ({ loaded: 1, indexing: 0 }),
      intervalMs: 1000,
    });
    expect(logger.info).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2500);
    expect(logger.info).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(5000);
    expect(logger.info).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('never lets a failing counter kill the daemon', () => {
    vi.mocked(logger.warn).mockClear();
    expect(() =>
      startVitalsLog({
        getCounts: () => {
          throw new Error('project manager exploded');
        },
        intervalMs: 60_000,
      })(),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});
