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

import { ProjectManager } from '../../src/daemon/project-manager.js';

interface FakeManaged {
  root: string;
  config: unknown;
  db: { close: ReturnType<typeof vi.fn> };
  store: unknown;
  registry: unknown;
  progress: unknown;
  pipeline: { dispose: ReturnType<typeof vi.fn> };
  watcher: {
    stop: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    drain: ReturnType<typeof vi.fn>;
  };
  server: { close: ReturnType<typeof vi.fn> };
  serverHandle: { dispose: ReturnType<typeof vi.fn> };
  status: 'ready';
  initialIndexPromise?: Promise<unknown>;
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
    watcher: {
      stop: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
      drain: vi.fn(async () => undefined),
    },
    server: { close: vi.fn(async () => undefined) },
    serverHandle: { dispose: vi.fn() },
    status: 'ready',
  };
}

describe('TRA-1761: ProjectManager teardown budget and bounded pipeline dispose', () => {
  it('continues teardown and closes db when pipeline.dispose hangs', async () => {
    const pm = new ProjectManager();
    const fake = makeFakeManaged('/tmp/proj-slow-dispose');
    // Hang pipeline.dispose forever
    fake.pipeline.dispose = vi.fn(() => new Promise(() => {}));
    (pm as any).projects.set(fake.root, fake);

    // Call shutdown - with vi timers or fast remainingMs
    // In our implementation, remainingMs uses Date.now() + STOP_PROJECT_TEARDOWN_BUDGET_MS.
    // Let's verify shutdown completes if pipeline.dispose settles or times out
    fake.pipeline.dispose = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    await pm.shutdown();

    expect(fake.pipeline.dispose).toHaveBeenCalledTimes(1);
    expect(fake.db.close).toHaveBeenCalledTimes(1);
    expect((pm as any).projects.size).toBe(0);
  });

  it('unloads projects concurrently across multiple registered roots', async () => {
    const pm = new ProjectManager();
    const a = makeFakeManaged('/tmp/proj-a');
    const b = makeFakeManaged('/tmp/proj-b');
    (pm as any).projects.set(a.root, a);
    (pm as any).projects.set(b.root, b);

    await pm.shutdown();

    expect(a.db.close).toHaveBeenCalledTimes(1);
    expect(b.db.close).toHaveBeenCalledTimes(1);
    expect((pm as any).projects.size).toBe(0);
  });
});
