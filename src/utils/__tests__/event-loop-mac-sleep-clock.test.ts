import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLoopLagMonitor } from '../event-loop.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'macOS sleep clock adapter',
  () => {
    afterEach(() => {
      vi.useRealTimers();
      vi.mocked(execFileSync).mockReset();
    });

    it('converts cumulative wake-clock ticks with the reported timebase frequency', () => {
      vi.useFakeTimers();
      const read = vi.mocked(execFileSync);
      read.mockReturnValueOnce('1000\n1000\n1000\n');
      read.mockReturnValueOnce('1000\n601000\n1000\n');
      let now = 0;
      const monitor = new EventLoopLagMonitor({
        intervalMs: 1000,
        thresholdMs: 2000,
        now: () => now,
      });
      monitor.start();
      now = 601_000;
      vi.advanceTimersByTime(1000);
      monitor.stop();
      expect(monitor.getStats()).toEqual({ stallCount: 0, maxLagMs: 0 });
      expect(read).toHaveBeenCalledWith(
        '/usr/sbin/sysctl',
        ['-n', 'machdep.wake_abstime', 'machdep.wake_conttime', 'hw.tbfrequency'],
        expect.any(Object),
      );
    });

    it('keeps a real stall if both OS clock queries fail', () => {
      vi.useFakeTimers();
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('sysctl unavailable');
      });
      let now = 0;
      const monitor = new EventLoopLagMonitor({
        intervalMs: 1000,
        thresholdMs: 2000,
        now: () => now,
      });
      monitor.start();
      now = 6000;
      vi.advanceTimersByTime(1000);
      monitor.stop();
      expect(monitor.getStats()).toEqual({ stallCount: 1, maxLagMs: 5000 });
    });
  },
);
