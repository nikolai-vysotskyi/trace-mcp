/**
 * Per-project idle-unload sweep (project_idle_unload_minutes). Mirrors the
 * fake-ManagedProject injection pattern used by
 * tests/daemon/project-manager-shutdown.test.ts / project-manager-abort.test.ts
 * rather than spinning up a real DB/watcher/server stack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/registry.js', () => ({
  listProjects: vi.fn(() => []),
  unregisterProject: vi.fn(),
}));

vi.mock('../../src/progress.js', () => ({
  ProgressState: vi.fn(),
  clearServerPid: vi.fn(),
  writeServerPid: vi.fn(),
}));

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

import { ProjectManager, type ManagedProject } from '../../src/daemon/project-manager.js';

interface FakeManaged {
  root: string;
  config: unknown;
  db: { close: ReturnType<typeof vi.fn> };
  store: unknown;
  registry: unknown;
  progress: unknown;
  pipeline: { dispose: ReturnType<typeof vi.fn> };
  watcher: { stop: ReturnType<typeof vi.fn> };
  server: { close: ReturnType<typeof vi.fn> };
  serverHandle: { dispose: ReturnType<typeof vi.fn> };
  status: 'starting' | 'indexing' | 'ready' | 'error';
  lastAccessedAt: number;
}

function makeFakeManaged(root: string, opts?: Partial<FakeManaged>): FakeManaged {
  return {
    root,
    config: {},
    db: { close: vi.fn() },
    store: {},
    registry: {},
    progress: {},
    pipeline: { dispose: vi.fn(async () => undefined) },
    watcher: { stop: vi.fn(async () => undefined) },
    server: { close: vi.fn(async () => undefined) },
    serverHandle: { dispose: vi.fn() },
    status: 'ready',
    lastAccessedAt: Date.now(),
    ...opts,
  };
}

function injectProject(pm: ProjectManager, root: string, opts?: Partial<FakeManaged>): FakeManaged {
  const fake = makeFakeManaged(root, opts);
  // biome-ignore lint/suspicious/noExplicitAny: bypassing private state for behavioural test
  (pm as any).projects.set(root, fake);
  return fake;
}

describe('ProjectManager.touchActivity', () => {
  it('updates lastAccessedAt for a loaded project', () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-a', { lastAccessedAt: 0 });

    pm.touchActivity('/tmp/proj-a');

    expect(a.lastAccessedAt).toBeGreaterThan(0);
  });

  it('is a no-op for a project that is not loaded', () => {
    const pm = new ProjectManager();
    // Must not throw even though nothing is registered.
    expect(() => pm.touchActivity('/tmp/never-loaded')).not.toThrow();
  });
});

describe('ProjectManager.unloadIdleProjects', () => {
  it('unloads (stopProject) a project idle past the threshold', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-a', { lastAccessedAt: Date.now() - 60_000 });

    const unloaded = await pm.unloadIdleProjects(30_000);

    expect(unloaded).toEqual(['/tmp/proj-a']);
    expect(a.watcher.stop).toHaveBeenCalledTimes(1);
    expect(a.db.close).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.has('/tmp/proj-a')).toBe(false);
  });

  it('does NOT unload a project accessed within the idle window', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-a', { lastAccessedAt: Date.now() });

    const unloaded = await pm.unloadIdleProjects(30_000);

    expect(unloaded).toEqual([]);
    expect(a.watcher.stop).not.toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.has('/tmp/proj-a')).toBe(true);
  });

  it('never unloads a project that is still indexing, even if idle', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-indexing', {
      status: 'indexing',
      lastAccessedAt: Date.now() - 3_600_000,
    });

    const unloaded = await pm.unloadIdleProjects(30_000);

    expect(unloaded).toEqual([]);
    expect(a.watcher.stop).not.toHaveBeenCalled();
  });

  it('never unloads a project that is still starting, even if idle', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-starting', {
      status: 'starting',
      lastAccessedAt: Date.now() - 3_600_000,
    });

    const unloaded = await pm.unloadIdleProjects(30_000);

    expect(unloaded).toEqual([]);
    expect(a.watcher.stop).not.toHaveBeenCalled();
  });

  it('never unloads a project with connected clients (resourcePool refCount > 0)', async () => {
    const resourcePool = {
      disposeProject: vi.fn(),
      acquire: vi.fn(),
      release: vi.fn(),
      disposeAll: vi.fn(),
      getRefCount: vi.fn((root: string) => (root === '/tmp/proj-busy' ? 1 : 0)),
    };
    // biome-ignore lint/suspicious/noExplicitAny: constructor accepts a partial test double
    const pm = new ProjectManager({ resourcePool: resourcePool as any });
    const busy = injectProject(pm, '/tmp/proj-busy', { lastAccessedAt: Date.now() - 3_600_000 });
    const idle = injectProject(pm, '/tmp/proj-idle', { lastAccessedAt: Date.now() - 3_600_000 });

    const unloaded = await pm.unloadIdleProjects(30_000);

    expect(unloaded).toEqual(['/tmp/proj-idle']);
    expect(busy.watcher.stop).not.toHaveBeenCalled();
    expect(idle.watcher.stop).toHaveBeenCalledTimes(1);
  });

  it('idleMs <= 0 disables the sweep entirely (no-op, does not touch any project)', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-a', { lastAccessedAt: 0 });

    const unloaded = await pm.unloadIdleProjects(0);

    expect(unloaded).toEqual([]);
    expect(a.watcher.stop).not.toHaveBeenCalled();
  });

  it('leaves sibling projects untouched when only one is idle', async () => {
    const pm = new ProjectManager();
    const idle = injectProject(pm, '/tmp/proj-idle', { lastAccessedAt: Date.now() - 3_600_000 });
    const fresh = injectProject(pm, '/tmp/proj-fresh', { lastAccessedAt: Date.now() });

    const unloaded = await pm.unloadIdleProjects(30_000);

    expect(unloaded).toEqual(['/tmp/proj-idle']);
    expect(idle.watcher.stop).toHaveBeenCalledTimes(1);
    expect(fresh.watcher.stop).not.toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.has('/tmp/proj-fresh')).toBe(true);
  });
});

describe('ProjectManager.startIdleUnloadSweep / stopIdleUnloadSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('unloads an idle project on the periodic sweep tick', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-a', { lastAccessedAt: Date.now() - 3_600_000 });

    pm.startIdleUnloadSweep(30_000, { intervalMs: 5 * 60_000 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(a.watcher.stop).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.has('/tmp/proj-a')).toBe(false);

    pm.stopIdleUnloadSweep();
  });

  it('fires onUnloaded with the unloaded roots (and only when something was unloaded)', async () => {
    const pm = new ProjectManager();
    // idleMs (30 min) far exceeds the sweep interval (5 min) so the fake-Date
    // advance of two ticks cannot age proj-fresh past the threshold.
    injectProject(pm, '/tmp/proj-idle', { lastAccessedAt: Date.now() - 3_600_000 });
    injectProject(pm, '/tmp/proj-fresh', { lastAccessedAt: Date.now() });
    const onUnloaded = vi.fn();

    pm.startIdleUnloadSweep(30 * 60_000, { intervalMs: 5 * 60_000, onUnloaded });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(onUnloaded).toHaveBeenCalledTimes(1);
    expect(onUnloaded).toHaveBeenCalledWith(['/tmp/proj-idle']);

    // Next tick: nothing left to unload (proj-fresh is only 10 min idle) —
    // the callback must NOT fire with an empty array.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(onUnloaded).toHaveBeenCalledTimes(1);

    pm.stopIdleUnloadSweep();
  });

  it('does not arm a timer when idleMs is 0 (disabled)', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-a', { lastAccessedAt: Date.now() - 3_600_000 });

    pm.startIdleUnloadSweep(0, { intervalMs: 5 * 60_000 });
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(a.watcher.stop).not.toHaveBeenCalled();
  });

  it('a touchActivity() call between ticks saves the project from the next sweep', async () => {
    const pm = new ProjectManager();
    // idleMs (20 min) is longer than the sweep interval (5 min) so the first
    // couple of ticks see the project as fresh; only silence past 20 min
    // should trigger an unload.
    const idleMs = 20 * 60_000;
    const sweepIntervalMs = 5 * 60_000;
    const a = injectProject(pm, '/tmp/proj-a', { lastAccessedAt: Date.now() });

    pm.startIdleUnloadSweep(idleMs, { intervalMs: sweepIntervalMs });
    // First tick (+5 min): well within the 20 min idle window.
    await vi.advanceTimersByTimeAsync(sweepIntervalMs);
    expect(a.watcher.stop).not.toHaveBeenCalled();

    // Touch resets the clock just before the next tick would push elapsed
    // time (10 min since last touch) close to the threshold.
    await vi.advanceTimersByTimeAsync(sweepIntervalMs);
    pm.touchActivity('/tmp/proj-a');

    // Two more ticks (+10 min since the touch) — still well under 20 min
    // from the touch, so the project must survive.
    await vi.advanceTimersByTimeAsync(sweepIntervalMs * 2);
    expect(a.watcher.stop).not.toHaveBeenCalled();

    pm.stopIdleUnloadSweep();
  });

  it('stopIdleUnloadSweep prevents further ticks from running', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-a', { lastAccessedAt: Date.now() - 3_600_000 });

    pm.startIdleUnloadSweep(30_000, { intervalMs: 5 * 60_000 });
    pm.stopIdleUnloadSweep();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(a.watcher.stop).not.toHaveBeenCalled();
  });

  it('shutdown() stops the sweep so no post-shutdown tick can fire', async () => {
    const pm = new ProjectManager();
    injectProject(pm, '/tmp/proj-a', { lastAccessedAt: Date.now() - 3_600_000 });

    pm.startIdleUnloadSweep(30_000, { intervalMs: 5 * 60_000 });
    await pm.shutdown();

    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).idleUnloadTimer).toBeNull();
  });
});

// Type-only sanity check: ManagedProject must expose lastAccessedAt so
// touchActivity()/unloadIdleProjects() compile against the real shape.
// (No runtime assertion — this is a compile-time guard.)
function _typeGuard(m: ManagedProject): number {
  return m.lastAccessedAt;
}
void _typeGuard;
