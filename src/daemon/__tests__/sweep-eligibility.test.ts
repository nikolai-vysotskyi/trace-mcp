/**
 * TRA-1625: the idle-unload sweep is a black box in the field.
 *
 * On 2026-09-18 the production daemon held 65 loaded projects (21 pointing at
 * deleted dirs) while the 5-minute sweep selected nothing for 4+ hours — with
 * a 30-minute TTL and an LRU ceiling of 8. The sweep logs only what it
 * unloads, so there was no way to tell a pinned set (refCount > 0) from a
 * constantly-touched set from a wedged timer. `sweepEligibility()` exposes
 * the skip reasons so the next such state is diagnosable from the vitals
 * line instead of a guess.
 */
import { describe, expect, it } from 'vitest';
import { ProjectManager } from '../project-manager.js';
import { buildVitals } from '../vitals-log.js';

type Status = 'ready' | 'indexing' | 'starting';

function harness(
  specs: Array<{ root: string; lastAccessedAt: number; status?: Status; refCount?: number }>,
): ProjectManager {
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
  return pm;
}

const now = Date.now();

describe('sweepEligibility', () => {
  it('classifies busy, pinned, fresh and evictable without unloading anything', () => {
    const pm = harness([
      { root: '/busy-indexing', lastAccessedAt: now - 100_000, status: 'indexing' },
      { root: '/busy-starting', lastAccessedAt: now - 100_000, status: 'starting' },
      { root: '/pinned', lastAccessedAt: now - 100_000, refCount: 2 },
      { root: '/fresh', lastAccessedAt: now - 1_000 },
      { root: '/evictable', lastAccessedAt: now - 100_000 },
    ]);

    expect(pm.sweepEligibility(30_000)).toEqual({
      loaded: 5,
      busy: 2,
      pinned: 1,
      fresh: 1,
      evictable: 1,
    });
    // Read-only: nothing was stopped.
    expect(pm.listProjects()).toHaveLength(5);
  });

  it('agrees with unloadIdleProjects on what the TTL path would unload', async () => {
    const specs = [
      { root: '/a', lastAccessedAt: now - 100_000 },
      { root: '/b', lastAccessedAt: now - 100_000, refCount: 1 },
      { root: '/c', lastAccessedAt: now - 1_000 },
      { root: '/d', lastAccessedAt: now - 100_000, status: 'indexing' as Status },
    ];
    const eligibility = harness(specs).sweepEligibility(30_000);
    expect(eligibility.evictable).toBe(1);

    const pm2 = harness(specs);
    (pm2 as unknown as { stopProject(root: string): Promise<void> }).stopProject = async (root) => {
      (pm2 as unknown as { projects: Map<string, unknown> }).projects.delete(root);
    };
    // TTL-only (maxLoaded 0): unloads exactly the evictable one.
    expect(await pm2.unloadIdleProjects(30_000, 0)).toEqual(['/a']);
  });

  it('reports everything non-busy non-pinned as fresh when the TTL is off', () => {
    const pm = harness([
      { root: '/a', lastAccessedAt: now - 100_000 },
      { root: '/b', lastAccessedAt: now - 100_000, refCount: 1 },
    ]);

    expect(pm.sweepEligibility(0)).toEqual({
      loaded: 2,
      busy: 0,
      pinned: 1,
      fresh: 1,
      evictable: 0,
    });
  });

  it('treats a missing resource pool as zero refcounts instead of throwing', () => {
    const pm = harness([{ root: '/a', lastAccessedAt: now - 100_000 }]);
    (pm as unknown as { resourcePool: null }).resourcePool = null;

    expect(pm.sweepEligibility(30_000).evictable).toBe(1);
  });
});

describe('buildVitals with sweep breakdown', () => {
  it('passes the sweep breakdown through when present', () => {
    const v = buildVitals({
      loaded: 5,
      indexing: 0,
      sweep: { busy: 2, pinned: 1, fresh: 1, evictable: 1 },
    });
    expect(v.sweep_busy).toBe(2);
    expect(v.sweep_pinned).toBe(1);
    expect(v.sweep_fresh).toBe(1);
    expect(v.sweep_evictable).toBe(1);
  });

  it('omits sweep fields when no breakdown is provided (backwards compatible)', () => {
    const v = buildVitals({ loaded: 5, indexing: 0 });
    expect('sweep_busy' in v).toBe(false);
    expect('sweep_evictable' in v).toBe(false);
  });
});
