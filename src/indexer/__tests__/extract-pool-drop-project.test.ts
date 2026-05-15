/**
 * ExtractPool.dropProject() — leak fix for daemon-shared warm-worker pool.
 *
 * Without this message channel, each worker's `extractorByRoot` and
 * `projectContextByRoot` Maps grow monotonically across a long-running
 * daemon's lifetime as projects are added/removed. The pool itself is a
 * singleton (one instance for the daemon) so the worker-internal Maps
 * survive every project lifecycle.
 *
 * These tests verify the API surface of the fix without spawning real
 * worker threads — the pool exposes a `dropProject()` method that
 * broadcasts a control message and is a no-op when no workers exist.
 */
import type { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtractPool } from '../extract-pool.js';

type PoolInternals = {
  workers: Worker[];
  terminated: boolean;
};

describe('ExtractPool.dropProject — worker cache eviction', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a no-op when no workers have been spawned yet', () => {
    const pool = new ExtractPool({ keepAlive: true });
    // Pool is lazy — `ensureStarted()` hasn't run, `workers` is empty.
    expect((pool as unknown as PoolInternals).workers.length).toBe(0);
    // Must not throw.
    expect(() => pool.dropProject('/some/project')).not.toThrow();
  });

  it('returns silently when called on a terminated pool', async () => {
    const pool = new ExtractPool({ keepAlive: true });
    await pool.terminate();
    expect((pool as unknown as PoolInternals).terminated).toBe(true);
    // Terminated pool must not crash on dropProject — workers are already gone.
    expect(() => pool.dropProject('/some/project')).not.toThrow();
  });

  it('posts a drop_project control message to every live worker', () => {
    const pool = new ExtractPool({ keepAlive: true });
    // Stub worker objects with spied postMessage. We bypass the real Worker
    // spawn (no bundled worker entry in vitest mode anyway) by mutating the
    // private slot directly — the unit under test is the message fan-out.
    const w1 = { postMessage: vi.fn() };
    const w2 = { postMessage: vi.fn() };
    const w3 = { postMessage: vi.fn() };
    (pool as unknown as PoolInternals).workers = [
      w1 as unknown as Worker,
      w2 as unknown as Worker,
      w3 as unknown as Worker,
    ];

    pool.dropProject('/Users/me/proj-a');

    const expected = { kind: 'drop_project', rootPath: '/Users/me/proj-a' };
    expect(w1.postMessage).toHaveBeenCalledExactlyOnceWith(expected);
    expect(w2.postMessage).toHaveBeenCalledExactlyOnceWith(expected);
    expect(w3.postMessage).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it('swallows postMessage errors from a mid-terminate worker', () => {
    const pool = new ExtractPool({ keepAlive: true });
    const live = { postMessage: vi.fn() };
    const dying = {
      postMessage: vi.fn(() => {
        throw new Error('worker is terminating');
      }),
    };
    (pool as unknown as PoolInternals).workers = [
      dying as unknown as Worker,
      live as unknown as Worker,
    ];

    // The dying worker's throw must not prevent the live worker from
    // receiving the eviction. Errors are intentionally swallowed.
    expect(() => pool.dropProject('/Users/me/proj-b')).not.toThrow();
    expect(live.postMessage).toHaveBeenCalledOnce();
  });

  it('does not broadcast after terminate() drains the worker list', async () => {
    const pool = new ExtractPool({ keepAlive: true });
    const w = { postMessage: vi.fn(), terminate: vi.fn(async () => 0) };
    (pool as unknown as PoolInternals).workers = [w as unknown as Worker];

    await pool.terminate();
    // terminate() also nulls the workers array — dropProject must observe
    // `terminated=true` and short-circuit before touching any stale refs.
    pool.dropProject('/Users/me/proj-c');
    expect(w.postMessage).not.toHaveBeenCalled();
  });
});
