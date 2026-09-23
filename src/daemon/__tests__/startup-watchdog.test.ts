/**
 * TRA-1843: `/health` reported `starting` for 87+ min because
 * `loadAllRegistered()` never settled. The per-call bounds fix the known
 * hang paths; this watchdog bounds the unknown ones — if startup has not
 * finished within budget it names the stuck roots and reports ready anyway
 * (per-project `indexing` still gates 503s, so `ok` means "serving").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { armStartupWatchdog } from '../startup-watchdog.js';

describe('armStartupWatchdog (TRA-1843)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires with the stuck roots when startup never finishes', () => {
    vi.useFakeTimers();
    const onStuck = vi.fn();
    armStartupWatchdog({
      timeoutMs: 1_000,
      getStuckRoots: () => ['/a', '/b'],
      onStuck,
    });

    expect(onStuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(onStuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck).toHaveBeenCalledWith(['/a', '/b']);
  });

  it('never fires once disarmed by a finished startup', () => {
    vi.useFakeTimers();
    const onStuck = vi.fn();
    const disarm = armStartupWatchdog({
      timeoutMs: 1_000,
      getStuckRoots: () => ['/a'],
      onStuck,
    });

    vi.advanceTimersByTime(500);
    disarm();
    vi.advanceTimersByTime(60_000);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it('still reports when the diagnostics themselves throw', () => {
    vi.useFakeTimers();
    const onStuck = vi.fn();
    armStartupWatchdog({
      timeoutMs: 1_000,
      getStuckRoots: () => {
        throw new Error('boom');
      },
      onStuck,
    });

    vi.advanceTimersByTime(1_000);
    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck).toHaveBeenCalledWith([]);
  });
});
