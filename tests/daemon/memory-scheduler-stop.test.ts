import { describe, expect, it, vi } from 'vitest';
import { MemoryScheduler } from '../../src/memory/scheduler/memory-scheduler.js';

describe('TRA-1761: MemoryScheduler bounded stop', () => {
  it('stop() drains fast tasks within timeout', async () => {
    let taskDone = false;
    const scheduler = new MemoryScheduler({
      projectManager: { listProjects: () => [] } as any,
      config: {} as any,
      startInterval: false,
    });

    (scheduler as any).queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 10));
      taskDone = true;
    });

    await scheduler.stop(2_000);
    expect(taskDone).toBe(true);
  });

  it('stop() times out and continues teardown when a stage hangs', async () => {
    const scheduler = new MemoryScheduler({
      projectManager: { listProjects: () => [] } as any,
      config: {} as any,
      startInterval: false,
    });

    // Enqueue a hung task that will never settle
    (scheduler as any).queue.enqueue(() => new Promise(() => {}));

    const start = Date.now();
    await scheduler.stop(50);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });
});
