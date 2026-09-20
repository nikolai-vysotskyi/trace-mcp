/**
 * TRA-1608 follow-up (Windows CI, PR #1286): teardown must tolerate map
 * entries stored under a raw spelling.
 *
 * `addProject()` inserts under `managerKey()` (`path.resolve`), but entries
 * can exist under other spellings (behavioural tests inject fakes directly;
 * callers may hold non-canonical strings). On Windows
 * `path.resolve('/tmp/proj-a')` is `D:\tmp\proj-a`, so a normalized-only
 * lookup missed every POSIX-fixture entry and `stopProject()` /
 * `removeProject()` / `shutdown()` silently no-op'd — 25 red lifecycle tests
 * on windows-latest, green elsewhere.
 *
 * These tests use RELATIVE fixture keys (`relative-proj-…`), for which
 * `path.resolve()` prepends the cwd on EVERY platform — so the
 * canonical-key-miss + raw-fallback path is exercised even on macOS/Linux,
 * where the original POSIX fixtures can't diverge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../registry.js', () => ({
  listProjects: vi.fn(() => []),
  unregisterProject: vi.fn(),
}));

vi.mock('../../progress.js', () => ({
  ProgressState: vi.fn(),
  clearServerPid: vi.fn(),
  writeServerPid: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import * as registry from '../../registry.js';
import { ProjectManager, managerKey } from '../../daemon/project-manager.js';

const mockUnregister = vi.mocked(registry.unregisterProject);

function makeFakeManaged(root: string) {
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
    status: 'ready' as const,
    lastAccessedAt: Date.now(),
  };
}

function injectRaw(pm: ProjectManager, root: string) {
  const fake = makeFakeManaged(root);
  // Direct map injection under the RAW spelling — bypasses addProject()'s
  // managerKey() normalization, like the lifecycle suites do.
  // biome-ignore lint/suspicious/noExplicitAny: bypassing private state for behavioural test
  (pm as any).projects.set(root, fake);
  return fake;
}

describe('ProjectManager raw-key teardown tolerance (TRA-1608)', () => {
  beforeEach(() => {
    mockUnregister.mockClear();
  });

  it('sanity: the fixture really diverges from its canonical key on this platform', async () => {
    const { managerKey: key } = await import('../../daemon/project-manager.js');
    expect(key('relative-proj-sanity')).not.toBe('relative-proj-sanity');
  });

  it('removeProject tears down a raw-spelling entry and passes it through', async () => {
    const pm = new ProjectManager();
    const a = injectRaw(pm, 'relative-proj-raw');

    await pm.removeProject('relative-proj-raw');

    expect(a.watcher.stop).toHaveBeenCalledTimes(1);
    expect(a.db.close).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledWith('relative-proj-raw');
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.size).toBe(0);
  });

  it('shutdown stops every raw-spelling entry', async () => {
    const pm = new ProjectManager();
    const a = injectRaw(pm, 'relative-proj-a');
    const b = injectRaw(pm, 'relative-proj-b');

    await pm.shutdown();

    expect(a.watcher.stop).toHaveBeenCalledTimes(1);
    expect(b.watcher.stop).toHaveBeenCalledTimes(1);
    expect(a.db.close).toHaveBeenCalledTimes(1);
    expect(b.db.close).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: test introspection
    expect((pm as any).projects.size).toBe(0);
  });

  it('getProject finds a raw-spelling entry', () => {
    const pm = new ProjectManager();
    const a = injectRaw(pm, 'relative-proj-get');
    expect(pm.getProject('relative-proj-get')).toBe(a as never);
  });
});
