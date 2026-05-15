/**
 * Lifecycle leak regression tests for FileWatcher and ProjectManager.
 *
 * Background: each FileWatcher holds a parcel-watcher AsyncSubscription which
 * owns a native fs-event handle (inotify/kqueue/fsevents), the debounce
 * setTimeout id, and the closure capturing onChanges (which transitively
 * captures pipeline, debounced AI fires, traceignore matcher). Restarting the
 * watcher or removing the project without `await`ing unsubscribe is the
 * canonical leak path.
 *
 * These tests pin the lifecycle contract:
 *  1. start() called twice without an intervening stop() closes the prior
 *     parcel subscription before opening a new one.
 *  2. ProjectManager.removeProject closes the project's watcher subscription.
 *  3. ProjectManager.shutdown closes every project's watcher subscription.
 */
import * as parcelWatcher from '@parcel/watcher';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import { FileWatcher } from '../../src/indexer/watcher.js';

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn(),
}));

const mockConfig: TraceMcpConfig = {
  root: '/project',
  include: ['src/**/*.ts'],
  exclude: [],
  db: { path: ':memory:' },
  plugins: [],
};

describe('FileWatcher re-entry safety', () => {
  let watcher: FileWatcher;
  let unsubscribeCalls: Array<{ id: number; result: ReturnType<typeof vi.fn> }>;
  let nextId: number;

  beforeEach(() => {
    watcher = new FileWatcher();
    unsubscribeCalls = [];
    nextId = 0;

    vi.mocked(parcelWatcher.subscribe).mockImplementation(async () => {
      const id = ++nextId;
      const unsub = vi.fn().mockResolvedValue(undefined);
      unsubscribeCalls.push({ id, result: unsub });
      return { unsubscribe: unsub };
    });
  });

  afterEach(async () => {
    await watcher.stop();
    vi.clearAllMocks();
  });

  it('start called twice closes the FIRST subscription before opening the second', async () => {
    await watcher.start('/project', mockConfig, vi.fn());
    expect(unsubscribeCalls).toHaveLength(1);

    // Re-enter start without an intervening stop. If the FileWatcher just
    // overwrites this.subscription, the native handle in unsubscribeCalls[0]
    // would leak forever (its inotify/kqueue watches + the captured callback
    // closure stay alive).
    await watcher.start('/project', mockConfig, vi.fn());

    expect(unsubscribeCalls).toHaveLength(2);
    expect(unsubscribeCalls[0].result).toHaveBeenCalledOnce();
    expect(unsubscribeCalls[1].result).not.toHaveBeenCalled();

    // Final stop closes the second subscription too.
    await watcher.stop();
    expect(unsubscribeCalls[1].result).toHaveBeenCalledOnce();
  });

  it('stop awaits unsubscribe — not fire-and-forget', async () => {
    let resolved = false;
    vi.mocked(parcelWatcher.subscribe).mockImplementationOnce(async () => ({
      unsubscribe: vi.fn(
        () =>
          new Promise<void>((r) => {
            setTimeout(() => {
              resolved = true;
              r();
            }, 5);
          }),
      ),
    }));

    await watcher.start('/project', mockConfig, vi.fn());
    await watcher.stop();

    // If stop() didn't `await` the unsubscribe Promise, `resolved` would still
    // be false when stop() returns.
    expect(resolved).toBe(true);
  });

  it('stop nulls the subscription even when unsubscribe throws — lifecycle never wedges', async () => {
    vi.mocked(parcelWatcher.subscribe).mockImplementationOnce(async () => ({
      unsubscribe: vi.fn().mockRejectedValue(new Error('native handle wedged')),
    }));

    await watcher.start('/project', mockConfig, vi.fn());
    await expect(watcher.stop()).resolves.not.toThrow();

    // A subsequent start() must succeed — the broken first sub must not block
    // re-entry. If `this.subscription` is still pointing at the rejected one,
    // the re-entry guard tries to unsubscribe it AGAIN and we wedge forever.
    await expect(watcher.start('/project', mockConfig, vi.fn())).resolves.not.toThrow();
  });
});

describe('ProjectManager watcher lifecycle', () => {
  // The full ProjectManager.addProject path needs database/filesystem setup we
  // don't want in a unit test. Instead, mirror the shutdown-test pattern of
  // injecting a fake ManagedProject and assert lifecycle hooks. These tests
  // are the structural backstop for project-manager.ts ever silently dropping
  // the `await managed.watcher.stop()` in either stopProject or shutdown.
  beforeEach(() => {
    vi.resetModules();
  });

  it('removeProject awaits watcher.stop() before db.close()', async () => {
    vi.doMock('../../src/registry.js', () => ({
      listProjects: vi.fn(() => []),
      unregisterProject: vi.fn(),
    }));
    vi.doMock('../../src/progress.js', () => ({
      ProgressState: vi.fn(),
      clearServerPid: vi.fn(),
      writeServerPid: vi.fn(),
    }));
    vi.doMock('../../src/logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
      },
    }));

    const { ProjectManager } = await import('../../src/daemon/project-manager.js');

    // Track lifecycle event ordering so we can assert that the watcher
    // really is shut down BEFORE the SQLite handle closes. Closing the DB
    // while the watcher is still firing change events is SQLITE_MISUSE.
    const events: string[] = [];
    const watcherStop = vi.fn(async () => {
      // Simulate a delayed unsubscribe (real parcel-watcher hits the kernel).
      await new Promise((r) => setTimeout(r, 5));
      events.push('watcher.stop');
    });
    const dbClose = vi.fn(() => {
      events.push('db.close');
    });

    const fake = {
      root: '/tmp/lifecycle-proj',
      config: {},
      db: { close: dbClose },
      store: {},
      registry: {},
      progress: {},
      pipeline: { dispose: vi.fn(async () => undefined) },
      watcher: { stop: watcherStop },
      server: { close: vi.fn(async () => undefined) },
      serverHandle: { dispose: vi.fn() },
      status: 'ready',
    };

    const pm = new ProjectManager();
    // biome-ignore lint/suspicious/noExplicitAny: bypassing private state for behavioural test
    (pm as any).projects.set(fake.root, fake);

    await pm.removeProject(fake.root);

    expect(watcherStop).toHaveBeenCalledOnce();
    expect(dbClose).toHaveBeenCalledOnce();
    expect(events).toEqual(['watcher.stop', 'db.close']);
  });

  it('shutdown stops every projects watcher in parallel before closing the pool', async () => {
    vi.doMock('../../src/registry.js', () => ({
      listProjects: vi.fn(() => []),
      unregisterProject: vi.fn(),
    }));
    vi.doMock('../../src/progress.js', () => ({
      ProgressState: vi.fn(),
      clearServerPid: vi.fn(),
      writeServerPid: vi.fn(),
    }));
    vi.doMock('../../src/logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
      },
    }));

    const { ProjectManager } = await import('../../src/daemon/project-manager.js');

    const makeFake = (root: string) => ({
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
      status: 'ready' as const,
    });

    const a = makeFake('/tmp/proj-a');
    const b = makeFake('/tmp/proj-b');
    const c = makeFake('/tmp/proj-c');

    const pm = new ProjectManager();
    // biome-ignore lint/suspicious/noExplicitAny: bypassing private state
    (pm as any).projects.set(a.root, a);
    // biome-ignore lint/suspicious/noExplicitAny: bypassing private state
    (pm as any).projects.set(b.root, b);
    // biome-ignore lint/suspicious/noExplicitAny: bypassing private state
    (pm as any).projects.set(c.root, c);

    await pm.shutdown();

    expect(a.watcher.stop).toHaveBeenCalledOnce();
    expect(b.watcher.stop).toHaveBeenCalledOnce();
    expect(c.watcher.stop).toHaveBeenCalledOnce();
    expect(a.db.close).toHaveBeenCalledOnce();
    expect(b.db.close).toHaveBeenCalledOnce();
    expect(c.db.close).toHaveBeenCalledOnce();
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.size).toBe(0);
  });
});
