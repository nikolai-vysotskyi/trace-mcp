/**
 * Phase 2.3 — concurrent indexAll() calls in the daemon are gated by
 * pLimit(parallel_initial_index). Adding 5 projects with cap=2 must never
 * leave more than 2 indexAll runs active at the same time. Watcher-driven
 * indexFiles() is intentionally NOT covered by the limiter — small batches.
 */
import { describe, expect, it } from 'vitest';
import { pLimit } from '../../src/daemon/project-manager.js';

describe('pLimit semaphore — used by ProjectManager.indexAllLimit', () => {
  it('at most N tasks run concurrently regardless of submission rate', async () => {
    const limit = pLimit(2);
    let active = 0;
    let peak = 0;
    const observed: number[] = [];

    async function task(): Promise<void> {
      active++;
      peak = Math.max(peak, active);
      observed.push(active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    }

    // Five concurrent submissions — five projects added in quick succession.
    await Promise.all(Array.from({ length: 5 }, () => limit(task)));

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
    // Sanity: every observation is also bounded.
    for (const a of observed) expect(a).toBeLessThanOrEqual(2);
  });

  it('cap=1 fully serializes', async () => {
    const limit = pLimit(1);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(1);
  });

  it('returns task results in order of submission', async () => {
    const limit = pLimit(2);
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        limit(async () => {
          await new Promise((r) => setTimeout(r, 5));
          return i;
        }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it('propagates rejections without breaking the queue', async () => {
    const limit = pLimit(2);
    const fulfilled: number[] = [];
    const settled = await Promise.allSettled([
      limit(async () => {
        throw new Error('boom');
      }),
      limit(async () => {
        fulfilled.push(1);
        return 1;
      }),
      limit(async () => {
        fulfilled.push(2);
        return 2;
      }),
    ]);
    expect(settled[0].status).toBe('rejected');
    expect(fulfilled).toEqual([1, 2]);
  });

  // WHY: if a wrapped fn rejects, `release()` must still decrement `active`
  // and dequeue the next waiter — otherwise the limiter leaks slots and
  // eventually deadlocks. Regression guard for the pre-Phase-2 helper.
  it('rejecting fn still releases the slot for the next queued task', async () => {
    const limit = pLimit(1);
    const started: string[] = [];

    const a = limit(async () => {
      started.push('a');
      throw new Error('a-fail');
    });
    const b = limit(async () => {
      started.push('b');
      return 'b';
    });
    const c = limit(async () => {
      started.push('c');
      return 'c';
    });

    const settled = await Promise.allSettled([a, b, c]);

    // The rejecting task must not strand `b`/`c` in the queue.
    expect(settled[0].status).toBe('rejected');
    expect(settled[1]).toEqual({ status: 'fulfilled', value: 'b' });
    expect(settled[2]).toEqual({ status: 'fulfilled', value: 'c' });
    expect(started).toEqual(['a', 'b', 'c']);
  });

  // WHY: bursty fan-out — N+1 submissions must never have >N concurrent
  // runners at any point. Stress check on top of the basic 5-task case.
  it('bursting N+1 tasks never exceeds the cap', async () => {
    const N = 3;
    const limit = pLimit(N);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: N + 1 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(N);
  });
});
