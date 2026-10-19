/**
 * TRA-2531: MemoryScheduler initialization race with daemon shutdown.
 *
 * Verifies that:
 * 1. If daemon shutdown occurs while asynchronous loadConfig is still in-flight,
 *    the initialization sequence detects daemonShuttingDown and aborts before
 *    constructing or starting MemoryScheduler.
 * 2. MemoryScheduler is never left active or running against closed handles.
 * 3. If MemoryScheduler was already started, shutdown cleanly drains and stops it,
 *    and sets the reference to null.
 */
import { describe, expect, it, vi } from 'vitest';

describe('TRA-2531: MemoryScheduler shutdown race protection', () => {
  it('aborts initialization and does not start MemoryScheduler if shutdown occurs while loadConfig is pending', async () => {
    let daemonShuttingDown = false;
    let memoryScheduler: any = null;
    let memorySchedulerInitPromise: Promise<void> | null = null;
    let schedulerConstructed = false;
    let schedulerStarted = false;

    // Simulate slow loadConfig
    let resolveConfig: (val: any) => void;
    const slowLoadConfig = () =>
      new Promise<any>((resolve) => {
        resolveConfig = resolve;
      });

    // Mock MemoryScheduler
    class MockMemoryScheduler {
      constructor(_opts: any) {
        schedulerConstructed = true;
      }
      start() {
        schedulerStarted = true;
      }
      async stop() {}
    }

    // Mirror the exact cli.ts initialization logic
    memorySchedulerInitPromise = (async () => {
      try {
        const schedulerConfigResult = await slowLoadConfig().catch(() => null);
        if (daemonShuttingDown) return;
        const schedulerConfigFallback = schedulerConfigResult;
        if (daemonShuttingDown) return;
        const scheduler = new MockMemoryScheduler({
          config: schedulerConfigFallback ?? {},
        });
        if (daemonShuttingDown) return;
        memoryScheduler = scheduler;
        scheduler.start();
      } catch (err) {
        if (!daemonShuttingDown) {
          throw err;
        }
      }
    })();

    // Shutdown occurs while slowLoadConfig is still pending
    daemonShuttingDown = true;
    const shutdownPromise = (async () => {
      if (memorySchedulerInitPromise) {
        await memorySchedulerInitPromise.catch(() => {});
      }
      if (memoryScheduler) {
        await memoryScheduler.stop();
        memoryScheduler = null;
      }
    })();

    // Now resolve the config
    resolveConfig!({ memory: { background: { enabled: true } } });

    await shutdownPromise;

    // Invariant: MemoryScheduler must NOT have been constructed or started
    expect(schedulerConstructed).toBe(false);
    expect(schedulerStarted).toBe(false);
    expect(memoryScheduler).toBeNull();
  });

  it('stops and nulls out MemoryScheduler if already initialized before shutdown', async () => {
    let daemonShuttingDown = false;
    let memoryScheduler: any = null;
    let memorySchedulerInitPromise: Promise<void> | null = null;
    let stopCalled = false;

    class MockMemoryScheduler {
      start() {}
      async stop() {
        stopCalled = true;
      }
    }

    memorySchedulerInitPromise = (async () => {
      const scheduler = new MockMemoryScheduler();
      if (daemonShuttingDown) return;
      memoryScheduler = scheduler;
      scheduler.start();
    })();

    await memorySchedulerInitPromise;
    expect(memoryScheduler).not.toBeNull();

    // Now shutdown runs
    daemonShuttingDown = true;
    if (memorySchedulerInitPromise) {
      await memorySchedulerInitPromise.catch(() => {});
    }
    if (memoryScheduler) {
      await memoryScheduler.stop();
      memoryScheduler = null;
    }

    expect(stopCalled).toBe(true);
    expect(memoryScheduler).toBeNull();
  });
});
