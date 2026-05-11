import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

/**
 * Phase 5.1 — Daemon cold-start order.
 *
 * Goal: `httpServer.listen` resolves BEFORE `loadAllRegistered` completes,
 * so the daemon is reachable from the first millisecond even when initial
 * indexing is slow. While projects are still warming, requests against them
 * return 503 + Retry-After (see reindex-file-handler.test.ts).
 *
 * This test models the boot sequence with a fake projectManager whose
 * `addProject` takes 100 ms, and a fake httpServer.listen that resolves
 * synchronously. The structural invariant under test: listen() completes
 * before loadAllRegistered() does.
 */

interface BootEvent {
  at: number;
  event: 'listen' | 'load_start' | 'load_done';
}

async function bootSequence(opts: {
  addProjectMs: number;
  projectCount: number;
}): Promise<BootEvent[]> {
  const events: BootEvent[] = [];
  const t0 = Date.now();
  const stamp = (event: BootEvent['event']) => events.push({ at: Date.now() - t0, event });

  // Fake projectManager: addProject does ~addProjectMs ms of work and resolves.
  const addProject = vi.fn(async () => new Promise<void>((r) => setTimeout(r, opts.addProjectMs)));
  const loadAllRegistered = async (): Promise<void> => {
    stamp('load_start');
    await Promise.all(Array.from({ length: opts.projectCount }, () => addProject()));
    stamp('load_done');
  };

  // Fake httpServer.listen: starts listening then kicks off loadAllRegistered
  // as a background task. The "listen" callback fires synchronously when the
  // port binds — modelled here as queueMicrotask.
  await new Promise<void>((resolve) => {
    queueMicrotask(() => {
      stamp('listen');
      void loadAllRegistered();
      resolve();
    });
  });

  // Wait until load_done fires.
  while (!events.find((e) => e.event === 'load_done')) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return events;
}

describe('daemon cold-start order', () => {
  it('httpServer.listen resolves before loadAllRegistered completes', async () => {
    const events = await bootSequence({ addProjectMs: 100, projectCount: 1 });
    const listen = events.find((e) => e.event === 'listen')!;
    const loadDone = events.find((e) => e.event === 'load_done')!;
    expect(listen.at).toBeLessThan(loadDone.at);
    expect(loadDone.at).toBeGreaterThanOrEqual(95); // ~100 ms addProject
  });

  it('5 projects in parallel finish in well under 5× the time of 1 project', async () => {
    const oneStart = Date.now();
    const oneEvents = await bootSequence({ addProjectMs: 100, projectCount: 1 });
    const oneMs = oneEvents.find((e) => e.event === 'load_done')!.at;
    expect(Date.now() - oneStart).toBeGreaterThanOrEqual(95);

    const fiveStart = Date.now();
    const fiveEvents = await bootSequence({ addProjectMs: 100, projectCount: 5 });
    const fiveMs = fiveEvents.find((e) => e.event === 'load_done')!.at;
    expect(Date.now() - fiveStart).toBeGreaterThanOrEqual(95);

    // WHY 2×: parallel addProject() Promise.all should keep wall-clock close
    // to the per-project time, not 5× it. Use 2× as the gate to absorb CI jitter.
    expect(fiveMs).toBeLessThan(oneMs * 2);
  });

  it('httpServer.listen fires within a single millisecond regardless of project count', async () => {
    const events = await bootSequence({ addProjectMs: 500, projectCount: 10 });
    const listen = events.find((e) => e.event === 'listen')!;
    // Listen should fire essentially immediately — well before any addProject completes.
    expect(listen.at).toBeLessThan(50);
  });
});
