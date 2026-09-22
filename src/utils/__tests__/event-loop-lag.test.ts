import { describe, expect, it } from 'vitest';
import { EventLoopLagMonitor } from '../event-loop.js';

// TRA-1828: the daemon needs its own stall counter — bulk reindex passes
// starved /health while daemon.log stayed green, so QA could not tell
// "clients dropped" apart from "daemon busy".

describe('EventLoopLagMonitor', () => {
  it('starts with zero stalls and zero max lag', () => {
    const monitor = new EventLoopLagMonitor({ intervalMs: 20, thresholdMs: 5000 });
    expect(monitor.getStats()).toEqual({ stallCount: 0, maxLagMs: 0 });
    monitor.stop();
  });

  it('counts a real event-loop stall', async () => {
    const stalled: Array<{ lagMs: number; maxLagMs: number; stallCount: number }> = [];
    const monitor = new EventLoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 40,
      onStall: (lagMs, maxLagMs, stallCount) => {
        stalled.push({ lagMs, maxLagMs, stallCount });
      },
    });
    monitor.start();
    // Block the loop well past the threshold so at least one tick drifts.
    const end = Date.now() + 200;
    while (Date.now() < end) {
      // busy-wait: the point is to starve the interval timer
    }
    // Let the starved tick fire.
    await new Promise((resolve) => setTimeout(resolve, 100));
    monitor.stop();
    const stats = monitor.getStats();
    expect(stats.stallCount).toBeGreaterThanOrEqual(1);
    expect(stats.maxLagMs).toBeGreaterThanOrEqual(40);
    expect(stalled.length).toBeGreaterThanOrEqual(1);
    expect(stalled[0]!.stallCount).toBe(1);
  });

  it('records no stall when the loop stays responsive', async () => {
    const monitor = new EventLoopLagMonitor({ intervalMs: 20, thresholdMs: 5000 });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    monitor.stop();
    expect(monitor.getStats()).toEqual({ stallCount: 0, maxLagMs: 0 });
  });

  it('stop() is idempotent and start() does not double-arm', async () => {
    const monitor = new EventLoopLagMonitor({ intervalMs: 20, thresholdMs: 5000 });
    monitor.start();
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    monitor.stop();
    monitor.stop();
    expect(monitor.getStats()).toEqual({ stallCount: 0, maxLagMs: 0 });
  });
});
