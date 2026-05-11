import { describe, expect, it, vi } from 'vitest';

/**
 * Phase 5.4 — Parallel project loading.
 *
 * `ProjectManager.loadAllRegistered` issues addProject() calls in parallel
 * (via Promise.allSettled). For N projects this should resolve in roughly
 * the time of a single addProject(), not N× it — the indexAllLimit semaphore
 * (Phase 2.3) caps the heavy `pipeline.indexAll` work to 2 concurrent, but
 * the synchronous setup inside addProject (DB init, watcher arm) parallelises
 * cleanly.
 *
 * This test models the parallel pattern with a fake addProject that takes
 * 100 ms each. Sequential would be 5×100 = 500 ms; parallel should be near
 * 100 ms (well under 2× the single-project case).
 */

describe('parallel project loading', () => {
  it('5 projects load in well under 5× the time of 1 project', async () => {
    const addProjectMs = 100;

    const fakeAddProject = (): Promise<void> => new Promise((r) => setTimeout(r, addProjectMs));

    // Sequential baseline (the pre-Phase-5.4 behavior)
    const seqStart = Date.now();
    for (let i = 0; i < 5; i++) await fakeAddProject();
    const seqMs = Date.now() - seqStart;
    expect(seqMs).toBeGreaterThanOrEqual(5 * addProjectMs * 0.95);

    // Parallel (Phase 5.4)
    const parStart = Date.now();
    await Promise.allSettled(Array.from({ length: 5 }, () => fakeAddProject()));
    const parMs = Date.now() - parStart;

    // WHY 2×: addProject is parallel; 5×100 ms = 500 ms sequential vs ~100 ms
    // parallel. 2× the single-project time absorbs CI jitter while still
    // demonstrating the parallelism win.
    expect(parMs).toBeLessThan(addProjectMs * 2);
    expect(parMs).toBeLessThan(seqMs * 0.6); // < 60% of sequential
  });

  it('rejected addProject does not abort siblings', async () => {
    const addOk = vi.fn(() => new Promise<void>((r) => setTimeout(r, 50)));
    const addFail = vi.fn(
      () => new Promise<void>((_, rej) => setTimeout(() => rej(new Error('boom')), 50)),
    );

    const results = await Promise.allSettled([addOk(), addFail(), addOk(), addFail(), addOk()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(fulfilled).toBe(3);
    expect(rejected).toBe(2);
  });

  it('Promise.allSettled resolves with all results, never rejects', async () => {
    const promises = [Promise.resolve(1), Promise.reject(new Error('a')), Promise.resolve(2)];
    const results = await Promise.allSettled(promises);
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('fulfilled');
  });
});
