import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLoopLagMonitor } from '../event-loop.js';

// TRA-1828: the daemon needs its own stall counter — bulk reindex passes
// starved /health while daemon.log stayed green, so QA could not tell
// "clients dropped" apart from "daemon busy".

describe('EventLoopLagMonitor', () => {
  afterEach(() => vi.useRealTimers());

  it('ignores a wall-clock jump and an OS-confirmed sleep, then counts a real stall', () => {
    vi.useFakeTimers();
    let activeMs = 0;
    let wallMs = 1_000_000;
    let sleepOffsetMs = 0;
    const stalled: number[] = [];
    const monitor = new EventLoopLagMonitor({
      intervalMs: 1000,
      thresholdMs: 2000,
      now: () => activeMs,
      wallNow: () => wallMs,
      sleepOffsetMs: () => sleepOffsetMs,
      onStall: (lagMs) => stalled.push(lagMs),
    });
    monitor.start();

    wallMs += 600_000;
    activeMs += 1000;
    vi.advanceTimersByTime(1000);
    expect(monitor.getStats()).toEqual({ stallCount: 0, maxLagMs: 0 });

    sleepOffsetMs += 600_000;
    wallMs += 601_000;
    activeMs += 601_000;
    vi.advanceTimersByTime(1000);
    expect(monitor.getStats()).toEqual({ stallCount: 0, maxLagMs: 0 });

    activeMs += 5000;
    wallMs += 5000;
    vi.advanceTimersByTime(1000);
    monitor.stop();
    expect(monitor.getStats()).toEqual({ stallCount: 1, maxLagMs: 4000 });
    expect(stalled).toEqual([4000]);
  });

  it('counts a long low-CPU delay when the OS has no new sleep signal', () => {
    vi.useFakeTimers();
    let activeMs = 0;
    let wallMs = 1_000_000;
    const monitor = new EventLoopLagMonitor({
      intervalMs: 1000,
      thresholdMs: 2000,
      now: () => activeMs,
      wallNow: () => wallMs,
      sleepOffsetMs: () => 0,
      sleepInterval: () => null,
    });
    monitor.start();
    activeMs += 600_000;
    wallMs += 600_000;
    vi.advanceTimersByTime(1000);
    monitor.stop();
    expect(monitor.getStats()).toEqual({ stallCount: 1, maxLagMs: 599_000 });
  });

  it('keeps the active stall around a confirmed sleep', () => {
    vi.useFakeTimers();
    let activeMs = 0;
    let wallMs = 1_000_000;
    let sleepOffsetMs = 0;
    const monitor = new EventLoopLagMonitor({
      intervalMs: 1000,
      thresholdMs: 2000,
      now: () => activeMs,
      wallNow: () => wallMs,
      sleepOffsetMs: () => sleepOffsetMs,
    });
    monitor.start();
    sleepOffsetMs = 600_000;
    activeMs += 605_000;
    wallMs += 605_000;
    vi.advanceTimersByTime(1000);
    monitor.stop();
    expect(monitor.getStats()).toEqual({ stallCount: 1, maxLagMs: 4000 });
  });

  it('subtracts multiple sleep cycles between ticks', () => {
    vi.useFakeTimers();
    let activeMs = 0;
    let sleepOffsetMs = 0;
    const monitor = new EventLoopLagMonitor({
      intervalMs: 1000,
      thresholdMs: 2000,
      now: () => activeMs,
      sleepOffsetMs: () => sleepOffsetMs,
    });
    monitor.start();
    // Two 600-second sleeps and five seconds of active work span one tick.
    sleepOffsetMs = 1_200_000;
    activeMs = 1_205_000;
    vi.advanceTimersByTime(1000);
    monitor.stop();
    expect(monitor.getStats()).toEqual({ stallCount: 1, maxLagMs: 4000 });
  });

  it('retries a clock sample when the machine sleeps during the OS read', () => {
    vi.useFakeTimers();
    const clockValues = [0, 0, 1000, 601_000, 601_000];
    const sleepOffsets = [0, 0, 600_000];
    const monitor = new EventLoopLagMonitor({
      intervalMs: 1000,
      thresholdMs: 2000,
      now: () => clockValues.shift() ?? 601_000,
      sleepOffsetMs: () => sleepOffsets.shift() ?? 600_000,
    });
    monitor.start();
    vi.advanceTimersByTime(1000);
    monitor.stop();
    expect(monitor.getStats()).toEqual({ stallCount: 0, maxLagMs: 0 });
    expect(clockValues).toEqual([]);
    expect(sleepOffsets).toEqual([]);
  });

  it('uses the last sleep interval when cumulative time is unavailable', () => {
    vi.useFakeTimers();
    let activeMs = 0;
    let wallMs = 1_000_000;
    const monitor = new EventLoopLagMonitor({
      intervalMs: 1000,
      thresholdMs: 2000,
      now: () => activeMs,
      wallNow: () => wallMs,
      sleepOffsetMs: () => null,
      sleepInterval: () => ({ startMs: 1_001_000, endMs: 1_601_000 }),
    });
    monitor.start();
    activeMs = 601_000;
    wallMs = 1_601_000;
    vi.advanceTimersByTime(1000);
    monitor.stop();
    expect(monitor.getStats()).toEqual({ stallCount: 0, maxLagMs: 0 });
  });

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

  it('calls onTick on every tick (TRA-1957 heartbeat source)', async () => {
    let ticks = 0;
    const monitor = new EventLoopLagMonitor({
      intervalMs: 20,
      thresholdMs: 5000,
      onTick: () => {
        ticks++;
      },
    });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    monitor.stop();
    expect(ticks).toBeGreaterThanOrEqual(2);
    expect(monitor.getStats()).toEqual({ stallCount: 0, maxLagMs: 0 });
  });
});
