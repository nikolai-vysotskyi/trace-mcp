/**
 * TRA-422 regression guard: `daemon_eager_load_projects` is a steady-state
 * ceiling, not just a startup budget.
 *
 * A loaded project costs ~100 MB resident (docs/daemon-memory.md), and before
 * this guard the eager cap only applied at boot — lazy loads (auto-register,
 * reindex-file) walked past it, so a daemon booted with 8 projects was holding
 * 11 three minutes later with nothing to bring it back down. Asserting RSS
 * directly would be flaky on CI runners; asserting the eviction that bounds it
 * is deterministic, and it is the thing that actually broke.
 */
import { describe, expect, it, vi } from 'vitest';
import { ProjectManager } from '../project-manager.js';

type Status = 'ready' | 'indexing' | 'starting';

/** Install fake loaded projects and stub the real teardown. Returns the roots stopped. */
function harness(
  specs: Array<{ root: string; lastAccessedAt: number; status?: Status; refCount?: number }>,
): { pm: ProjectManager; stopped: string[] } {
  const pm = new ProjectManager();
  const projects = (pm as unknown as { projects: Map<string, unknown> }).projects;
  for (const s of specs) {
    projects.set(s.root, {
      root: s.root,
      lastAccessedAt: s.lastAccessedAt,
      status: s.status ?? 'ready',
    });
  }
  (pm as unknown as { resourcePool: { getRefCount(root: string): number } }).resourcePool = {
    getRefCount: (root) => specs.find((s) => s.root === root)?.refCount ?? 0,
  };
  const stopped: string[] = [];
  (pm as unknown as { stopProject(root: string): Promise<void> }).stopProject = async (root) => {
    stopped.push(root);
    projects.delete(root);
  };
  return { pm, stopped };
}

const now = Date.now();

describe('unloadIdleProjects — loaded-project ceiling', () => {
  it('evicts down to maxLoaded, least-recently-accessed first', async () => {
    const { pm, stopped } = harness([
      { root: '/a', lastAccessedAt: now - 5_000 },
      { root: '/b', lastAccessedAt: now - 4_000 },
      { root: '/c', lastAccessedAt: now - 3_000 },
      { root: '/d', lastAccessedAt: now - 2_000 },
      { root: '/e', lastAccessedAt: now - 1_000 },
    ]);

    const unloaded = await pm.unloadIdleProjects(0, 3);

    expect(unloaded.sort()).toEqual(['/a', '/b']);
    expect(stopped.sort()).toEqual(['/a', '/b']);
    expect(pm.listProjects()).toHaveLength(3);
  });

  it('never evicts a busy or indexing project to satisfy the ceiling', async () => {
    // Only /e is evictable, so the daemon stays over the cap rather than
    // tearing down work in flight — the ceiling is best-effort by design.
    const { pm } = harness([
      { root: '/a', lastAccessedAt: now - 5_000, refCount: 1 },
      { root: '/b', lastAccessedAt: now - 4_000, status: 'indexing' },
      { root: '/c', lastAccessedAt: now - 3_000, status: 'starting' },
      { root: '/d', lastAccessedAt: now - 2_000, refCount: 2 },
      { root: '/e', lastAccessedAt: now - 1_000 },
    ]);

    expect(await pm.unloadIdleProjects(0, 1)).toEqual(['/e']);
    expect(pm.listProjects()).toHaveLength(4);
  });

  it('is a no-op while at or under the ceiling', async () => {
    const { pm, stopped } = harness([
      { root: '/a', lastAccessedAt: now - 5_000 },
      { root: '/b', lastAccessedAt: now - 1_000 },
    ]);

    expect(await pm.unloadIdleProjects(0, 2)).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it('combines with the idle TTL without double-counting an eviction', async () => {
    // /a is both the LRU and past the 2s TTL. Over the cap by one, so exactly
    // one project goes — not two.
    const { pm } = harness([
      { root: '/a', lastAccessedAt: now - 10_000 },
      { root: '/b', lastAccessedAt: now - 1_000 },
      { root: '/c', lastAccessedAt: now - 500 },
    ]);

    expect(await pm.unloadIdleProjects(2_000, 2)).toEqual(['/a']);
  });

  it('maxLoaded = 0 leaves the ceiling off (TTL-only, as before)', async () => {
    const { pm } = harness([
      { root: '/a', lastAccessedAt: now - 5_000 },
      { root: '/b', lastAccessedAt: now - 4_000 },
      { root: '/c', lastAccessedAt: now - 3_000 },
    ]);

    expect(await pm.unloadIdleProjects(0, 0)).toEqual([]);
  });
});

describe('startIdleUnloadSweep — ceiling wiring', () => {
  it('arms the timer for a ceiling even when the TTL is disabled', async () => {
    vi.useFakeTimers();
    try {
      const { pm, stopped } = harness([
        { root: '/a', lastAccessedAt: now - 5_000 },
        { root: '/b', lastAccessedAt: now - 1_000 },
      ]);
      pm.startIdleUnloadSweep(0, { intervalMs: 1_000, maxLoaded: 1 });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(stopped).toEqual(['/a']);
      pm.stopIdleUnloadSweep();
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms nothing when both the TTL and the ceiling are off', async () => {
    vi.useFakeTimers();
    try {
      const { pm, stopped } = harness([
        { root: '/a', lastAccessedAt: now - 5_000 },
        { root: '/b', lastAccessedAt: now - 1_000 },
      ]);
      pm.startIdleUnloadSweep(0, { intervalMs: 1_000, maxLoaded: 0 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stopped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
