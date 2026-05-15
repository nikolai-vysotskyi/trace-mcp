import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import * as registry from '../../src/registry.js';
import { ProjectManager } from '../../src/daemon/project-manager.js';

const mockUnregister = vi.mocked(registry.unregisterProject);

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
  status: 'ready';
}

function makeFakeManaged(root: string): FakeManaged {
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
  };
}

function injectProject(pm: ProjectManager, root: string): FakeManaged {
  const fake = makeFakeManaged(root);
  // biome-ignore lint/suspicious/noExplicitAny: bypassing private state for behavioural test
  (pm as any).projects.set(root, fake);
  return fake;
}

describe('ProjectManager.shutdown', () => {
  beforeEach(() => {
    mockUnregister.mockClear();
  });

  it('does NOT unregister projects from the on-disk registry', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-a');
    const b = injectProject(pm, '/tmp/proj-b');

    await pm.shutdown();

    expect(mockUnregister).not.toHaveBeenCalled();
    expect(a.watcher.stop).toHaveBeenCalledTimes(1);
    expect(b.watcher.stop).toHaveBeenCalledTimes(1);
    expect(a.server.close).toHaveBeenCalledTimes(1);
    expect(b.server.close).toHaveBeenCalledTimes(1);
    expect(a.serverHandle.dispose).toHaveBeenCalledTimes(1);
    expect(a.db.close).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.size).toBe(0);
  });

  it('is a no-op when no projects are loaded (does not touch registry)', async () => {
    const pm = new ProjectManager();
    await pm.shutdown();
    expect(mockUnregister).not.toHaveBeenCalled();
  });
});

describe('ProjectManager.removeProject', () => {
  beforeEach(() => {
    mockUnregister.mockClear();
  });

  it('stops the project AND unregisters it from the registry', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-a');

    await pm.removeProject('/tmp/proj-a');

    expect(mockUnregister).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledWith('/tmp/proj-a');
    expect(a.watcher.stop).toHaveBeenCalledTimes(1);
    expect(a.server.close).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.size).toBe(0);
  });

  it('still unregisters even if the project is not loaded in memory', async () => {
    const pm = new ProjectManager();

    await pm.removeProject('/tmp/never-loaded');

    expect(mockUnregister).toHaveBeenCalledWith('/tmp/never-loaded');
  });

  it('removing one project does not affect siblings', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-a');
    const b = injectProject(pm, '/tmp/proj-b');

    await pm.removeProject('/tmp/proj-a');

    expect(mockUnregister).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledWith('/tmp/proj-a');
    expect(a.watcher.stop).toHaveBeenCalledTimes(1);
    expect(b.watcher.stop).not.toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.size).toBe(1);
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.has('/tmp/proj-b')).toBe(true);
  });

  it('notifies the shared ExtractPool so workers drop per-project caches', async () => {
    const pm = new ProjectManager();
    injectProject(pm, '/tmp/proj-a');

    // Inject a fake sharedPool capturing dropProject calls. The real pool
    // owns warm worker threads keyed by rootPath; without this notification
    // the workers leak FileExtractor + ProjectContext entries for every
    // project that ever lived in the daemon.
    const dropProject = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: bypassing private state for behavioural test
    (pm as any).sharedPool = { dropProject };

    await pm.removeProject('/tmp/proj-a');

    expect(dropProject).toHaveBeenCalledExactlyOnceWith('/tmp/proj-a');
  });

  it('survives a sharedPool.dropProject throw without aborting removal', async () => {
    const pm = new ProjectManager();
    const a = injectProject(pm, '/tmp/proj-c');

    const dropProject = vi.fn(() => {
      throw new Error('pool broken');
    });
    // biome-ignore lint/suspicious/noExplicitAny: bypassing private state for behavioural test
    (pm as any).sharedPool = { dropProject };

    await pm.removeProject('/tmp/proj-c');

    // Removal still completes — pool error is non-fatal.
    expect(mockUnregister).toHaveBeenCalledWith('/tmp/proj-c');
    expect(a.watcher.stop).toHaveBeenCalledOnce();
    expect(dropProject).toHaveBeenCalledOnce();
  });
});
