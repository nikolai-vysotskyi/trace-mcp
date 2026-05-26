/**
 * stopProject() must abort the per-project AbortController BEFORE
 * pipeline.dispose() runs, so in-flight AI fetches bail out instead of
 * touching a Store/ProjectContext that has been disposed.
 *
 * We do NOT instantiate the full daemon stack here — that would require a
 * live DB, watcher, etc. Instead, we inject a fake ManagedProject (mirroring
 * the existing tests/daemon/project-manager-shutdown.test.ts pattern) that
 * carries a real AbortController and observe the abort order against
 * pipeline.dispose().
 */
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
  watcher: { stop: ReturnType<typeof vi.fn> };
  server: { close: ReturnType<typeof vi.fn> };
  serverHandle: { dispose: ReturnType<typeof vi.fn> };
  status: 'ready';
  aiAbortController: AbortController;
  cancelDebouncedAI: ReturnType<typeof vi.fn>;
}

function makeFakeManaged(root: string, callOrder: string[]): FakeManaged {
  const aiAbortController = new AbortController();
  return {
    root,
    config: {},
    db: { close: vi.fn() },
    store: {},
    registry: {},
    progress: {},
    pipeline: {
      dispose: vi.fn(async () => {
        callOrder.push('pipeline.dispose');
      }),
    },
    watcher: {
      stop: vi.fn(async () => {
        callOrder.push('watcher.stop');
      }),
    },
    server: {
      close: vi.fn(async () => {
        callOrder.push('server.close');
      }),
    },
    serverHandle: {
      dispose: vi.fn(() => {
        callOrder.push('serverHandle.dispose');
      }),
    },
    status: 'ready',
    aiAbortController,
    cancelDebouncedAI: vi.fn(() => {
      callOrder.push('cancelDebouncedAI');
    }),
  };
}

function injectProject(pm: ProjectManager, fake: FakeManaged): FakeManaged {
  // biome-ignore lint/suspicious/noExplicitAny: bypassing private state for behavioural test
  (pm as any).projects.set(fake.root, fake);
  return fake;
}

describe('ProjectManager.stopProject — AbortSignal teardown', () => {
  it('aborts aiAbortController BEFORE pipeline.dispose() runs', async () => {
    const pm = new ProjectManager();
    const callOrder: string[] = [];
    const fake = makeFakeManaged('/tmp/proj-abort', callOrder);

    // Wrap abort() so we can assert ordering vs pipeline.dispose.
    const abortSpy = vi.fn(() => {
      callOrder.push('aiAbort');
    });
    fake.aiAbortController.abort = abortSpy as unknown as typeof fake.aiAbortController.abort;

    injectProject(pm, fake);
    await pm.removeProject('/tmp/proj-abort');

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(fake.pipeline.dispose).toHaveBeenCalledTimes(1);

    // The whole point of the fix: abort happens before dispose so any
    // in-flight summarize/embed batch sees signal.aborted=true and bails out
    // before the pipeline tears down the Store it was about to write to.
    const abortIdx = callOrder.indexOf('aiAbort');
    const disposeIdx = callOrder.indexOf('pipeline.dispose');
    expect(abortIdx).toBeGreaterThanOrEqual(0);
    expect(disposeIdx).toBeGreaterThanOrEqual(0);
    expect(abortIdx).toBeLessThan(disposeIdx);
  });

  it('a stub AI op observing signal.aborted sees true after stopProject', async () => {
    // Mirrors what summarizeUnsummarized / indexUnembedded do internally:
    // they receive the signal, await a long-running fetch, and check
    // .aborted at each step. After stopProject, the captured signal must
    // report aborted=true so the op bails on its next check.
    const pm = new ProjectManager();
    const callOrder: string[] = [];
    const fake = makeFakeManaged('/tmp/proj-stub', callOrder);
    injectProject(pm, fake);

    const capturedSignal = fake.aiAbortController.signal;
    expect(capturedSignal.aborted).toBe(false);

    let observedAfterStop = false;
    capturedSignal.addEventListener(
      'abort',
      () => {
        observedAfterStop = true;
      },
      { once: true },
    );

    await pm.removeProject('/tmp/proj-stub');

    expect(capturedSignal.aborted).toBe(true);
    expect(observedAfterStop).toBe(true);
  });

  it('survives missing aiAbortController on the managed record (back-compat)', async () => {
    // Older code paths or tests that build a ManagedProject without the
    // controller must still tear down cleanly — the field is optional.
    const pm = new ProjectManager();
    const callOrder: string[] = [];
    const fake = makeFakeManaged('/tmp/proj-no-ctrl', callOrder);
    // biome-ignore lint/suspicious/noExplicitAny: simulate older record shape
    (fake as any).aiAbortController = undefined;
    injectProject(pm, fake);

    // removeProject now returns artifact cleanup metadata (see project-artifacts.ts).
    // Back-compat contract here is "resolves cleanly without throwing"; we only
    // assert the shape, not specific counts (no on-disk DB exists for /tmp/proj-no-ctrl).
    const result = await pm.removeProject('/tmp/proj-no-ctrl');
    expect(result).toMatchObject({ deleted: expect.any(Array), freedBytes: expect.any(Number) });
    expect(fake.pipeline.dispose).toHaveBeenCalledTimes(1);
  });

  it('shutdown() also aborts the per-project controller', async () => {
    const pm = new ProjectManager();
    const callOrder: string[] = [];
    const fakeA = makeFakeManaged('/tmp/proj-sd-a', callOrder);
    const fakeB = makeFakeManaged('/tmp/proj-sd-b', callOrder);
    injectProject(pm, fakeA);
    injectProject(pm, fakeB);

    const signalA = fakeA.aiAbortController.signal;
    const signalB = fakeB.aiAbortController.signal;

    await pm.shutdown();

    expect(signalA.aborted).toBe(true);
    expect(signalB.aborted).toBe(true);
  });
});
