import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  acceptReindexFile,
  clearProjectStopping,
  handleReindexFile,
  isReindexing,
  markProjectStopping,
} from '../../src/daemon/reindex-file-handler.js';
import { __resetReindexStatsForTests, getReindexStats } from '../../src/daemon/reindex-stats.js';
import { __resetRecentReindexCache } from '../../src/indexer/recent-reindex-cache.js';
import { logger } from '../../src/logger.js';
import { LockError } from '../../src/utils/pid-lock.js';

/**
 * #1480: the hook path must get its answer before the incremental reindex
 * runs. Answering only after `indexFiles()` made every edit on a large
 * project outrun the hook's 2 s curl timeout on a healthy daemon.
 */

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const busy = (): LockError =>
  new LockError('Lock held', {
    pid: process.pid,
    hostname: os.hostname(),
    op: 'reindex',
    started_at: Date.now(),
  });

const passThroughLock = () => vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => fn());

async function drained(project: string): Promise<void> {
  await vi.waitFor(() => expect(isReindexing(project)).toBe(false), { timeout: 5_000 });
}

describe('acceptReindexFile (#1480)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRecentReindexCache();
    __resetReindexStatsForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers before any indexing work starts and holds the in-flight mark until it ends', async () => {
    const project = '/tmp/proj-1480-ack';
    const gate = deferred();
    const indexFiles = vi.fn(async (_paths: string[]) => {
      await gate.promise;
      return { totalFiles: 1, indexed: 1, skipped: 0, errors: 0, durationMs: 5 };
    });
    const getProject = vi.fn((root: string) =>
      root === project ? { pipeline: { indexFiles }, status: 'ready' as const } : undefined,
    );
    const lock = passThroughLock();

    const result = acceptReindexFile(
      { project, path: 'src/a.ts' },
      // biome-ignore lint/suspicious/noExplicitAny: test fake lock signature
      { getProject, lock: lock as any },
    );
    expect(result).toEqual({ ok: true, relPath: 'src/a.ts', queued: true });
    // Nothing that costs time (lock acquire + fsync, path filtering) may run
    // before the route writes its 202 — only the in-flight mark, which
    // stopProject() drains on.
    expect(lock).not.toHaveBeenCalled();
    expect(isReindexing(project)).toBe(true);

    await vi.waitFor(() =>
      expect(indexFiles).toHaveBeenCalledWith(['src/a.ts'], expect.anything()),
    );
    expect((lock.mock.calls[0][0] as { name: string }).name).toMatch(/-reindex$/);
    expect(isReindexing(project)).toBe(true);

    gate.resolve();
    await drained(project);
    expect(getReindexStats().summarize().indexed).toBe(1);
  });

  it('batches files that arrive during a run and reports one event per file', async () => {
    const project = '/tmp/proj-1480-batch';
    const gate = deferred();
    const indexFiles = vi
      .fn(async (paths: string[]) => ({
        totalFiles: paths.length,
        indexed: paths.length,
        skipped: 0,
        errors: 0,
        durationMs: 7,
      }))
      .mockImplementationOnce(async () => {
        await gate.promise;
        return { totalFiles: 1, indexed: 1, skipped: 0, errors: 0, durationMs: 7 };
      });
    const getProject = vi.fn((root: string) =>
      root === project ? { pipeline: { indexFiles } } : undefined,
    );
    // biome-ignore lint/suspicious/noExplicitAny: test fake lock signature
    const deps = { getProject, lock: passThroughLock() as any };

    acceptReindexFile({ project, path: 'src/a.ts' }, deps);
    await vi.waitFor(() => expect(indexFiles).toHaveBeenCalledTimes(1));
    acceptReindexFile({ project, path: 'src/b.ts' }, deps);
    acceptReindexFile({ project, path: 'src/c.ts' }, deps);
    gate.resolve();
    await drained(project);

    expect(indexFiles.mock.calls.map((c) => c[0])).toEqual([
      ['src/a.ts'],
      ['src/b.ts', 'src/c.ts'],
    ]);
    const events = getReindexStats().snapshot();
    expect(events).toHaveLength(3);
    // Each file reports the batch's work, not N times it.
    expect(events.map((e) => e.elapsedMs)).toEqual([7, 7, 7]);
    expect(getReindexStats().summarize().indexed).toBe(3);
  });

  it('keeps waiting while the lock holder is alive, past any fixed deadline', async () => {
    // The `reindex` tool holds the same lock for a whole indexAll — minutes on
    // a large project. The request was already answered 2xx, so dropping it
    // would leave the edit out of the index until the next one.
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setImmediate',
        'clearImmediate',
        'performance',
        'Date',
      ],
    });
    const project = '/tmp/proj-1480-long-holder';
    const indexFiles = vi.fn(async (_paths: string[]) => undefined);
    const getProject = vi.fn((root: string) =>
      root === project ? { pipeline: { indexFiles } } : undefined,
    );
    let holderDone = false;
    const lock = vi.fn(async (_opts: unknown, fn: () => Promise<unknown>) => {
      if (!holderDone) throw busy();
      return fn();
    });

    acceptReindexFile(
      { project, path: 'src/a.ts' },
      // biome-ignore lint/suspicious/noExplicitAny: test fake lock signature
      { getProject, lock: lock as any },
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(indexFiles).not.toHaveBeenCalled();
    expect(isReindexing(project)).toBe(true);
    // One "still waiting" warn, not one per attempt.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatch(/still waiting/);

    holderDone = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(indexFiles).toHaveBeenCalledWith(['src/a.ts'], expect.anything());
    expect(isReindexing(project)).toBe(false);
    expect(getReindexStats().summarize().errors).toBe(0);
  });

  it('a batch dropped for a stopping project is recorded and does not dedup the next reindex', async () => {
    const project = '/tmp/proj-1480-stopping';
    const indexFiles = vi.fn(async (_paths: string[]) => undefined);
    const getProject = vi.fn((root: string) =>
      root === project ? { pipeline: { indexFiles } } : undefined,
    );
    const lock = vi.fn(async () => {
      // First attempt finds the lock busy; the stop lands during the backoff.
      markProjectStopping(project);
      throw busy();
    });

    try {
      acceptReindexFile(
        { project, path: 'src/a.ts' },
        // biome-ignore lint/suspicious/noExplicitAny: test fake lock signature
        { getProject, lock: lock as any, queueRetry: { delayMs: 1 } },
      );
      await drained(project);
    } finally {
      clearProjectStopping(project);
    }

    expect(lock).toHaveBeenCalledTimes(1);
    expect(indexFiles).not.toHaveBeenCalled();
    const [dropped] = getReindexStats().snapshot();
    expect(dropped.error).toBe(true);
    // No indexing work ran — the wait goes to queuedMs, not the work percentiles.
    expect(dropped.elapsedMs).toBe(0);

    // The file was marked "just reindexed" when accepted; it never was.
    const again = await handleReindexFile(
      { project, path: 'src/a.ts' },
      // biome-ignore lint/suspicious/noExplicitAny: test fake lock signature
      { getProject, lock: passThroughLock() as any },
    );
    expect(again).toEqual({ ok: true, relPath: 'src/a.ts' });
    expect(indexFiles).toHaveBeenCalledWith(['src/a.ts']);
  });

  it('passes the project abort signal so stopProject() can stop a running batch', async () => {
    const project = '/tmp/proj-1480-abort';
    const indexAbortController = new AbortController();
    const indexFiles = vi.fn(
      async (_paths: string[], _opts?: { signal?: AbortSignal }) => undefined,
    );
    const getProject = vi.fn((root: string) =>
      root === project ? { pipeline: { indexFiles }, indexAbortController } : undefined,
    );

    acceptReindexFile(
      { project, path: 'src/a.ts' },
      // biome-ignore lint/suspicious/noExplicitAny: test fake lock signature
      { getProject, lock: passThroughLock() as any },
    );
    await drained(project);

    expect(indexFiles.mock.calls[0][1]?.signal).toBe(indexAbortController.signal);
  });
});
