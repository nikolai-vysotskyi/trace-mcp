import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReindexQueue } from './reindex-queue.js';

describe('createReindexQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once per file after the debounce window', async () => {
    const calls: string[] = [];
    const q = createReindexQueue({
      debounceMs: 100,
      spawn: async (p) => {
        calls.push(p);
      },
    });

    q.enqueue('a.ts');
    expect(q.pendingCount()).toBe(1);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    // Allow the spawn microtask to run
    await Promise.resolve();
    expect(calls).toEqual(['a.ts']);
    expect(q.pendingCount()).toBe(0);
  });

  it('coalesces multiple saves of the same file into one spawn', async () => {
    const calls: string[] = [];
    const q = createReindexQueue({
      debounceMs: 100,
      spawn: async (p) => {
        calls.push(p);
      },
    });

    q.enqueue('x.ts');
    await vi.advanceTimersByTimeAsync(50);
    q.enqueue('x.ts');
    await vi.advanceTimersByTimeAsync(50);
    q.enqueue('x.ts');
    await vi.advanceTimersByTimeAsync(50);

    expect(calls).toHaveLength(0); // window keeps resetting
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(calls).toEqual(['x.ts']);
  });

  it('runs separate timers for distinct files', async () => {
    const calls: string[] = [];
    const q = createReindexQueue({
      debounceMs: 100,
      spawn: async (p) => {
        calls.push(p);
      },
    });

    q.enqueue('a.ts');
    q.enqueue('b.ts');
    expect(q.pendingCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    expect(calls.sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('dispose() cancels every pending timer', async () => {
    const calls: string[] = [];
    const q = createReindexQueue({
      debounceMs: 100,
      spawn: async (p) => {
        calls.push(p);
      },
    });

    q.enqueue('a.ts');
    q.enqueue('b.ts');
    q.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(0);
    expect(q.pendingCount()).toBe(0);
  });

  it('routes spawn rejections to the onError sink without crashing', async () => {
    const errs: Array<{ p: string; e: unknown }> = [];
    const q = createReindexQueue({
      debounceMs: 50,
      spawn: async () => {
        throw new Error('boom');
      },
      onError: (p, e) => errs.push({ p, e }),
    });

    q.enqueue('a.ts');
    await vi.advanceTimersByTimeAsync(60);
    // Queue's internal `void spawn(...).catch(...)` chains a microtask;
    // flush a few ticks of the microtask queue so the rejection lands.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(errs).toHaveLength(1);
    expect(errs[0].p).toBe('a.ts');
    expect((errs[0].e as Error).message).toBe('boom');
  });
});
