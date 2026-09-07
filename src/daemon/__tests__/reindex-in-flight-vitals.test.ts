/**
 * TRA-1125: the daemon logged itself idle while it was busy.
 *
 * `projects_indexing` was derived only from `ManagedProject.status`, which the
 * initial-load path sets. `handleReindexFile` requires status `ready` to
 * proceed and never changes it, so incremental reindex — the dominant workload
 * on an active machine — was invisible. 264 of 264 measured vitals samples
 * reported `projects_indexing: 0` across a window in which the daemon burned
 * 99.3% CPU on a reindex burst, which silently contaminated every "idle RSS"
 * figure we had.
 */
import { describe, expect, it, vi } from 'vitest';
import { countReindexingProjects, handleReindexFile } from '../reindex-file-handler.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const root = process.cwd();

describe('countReindexingProjects', () => {
  it('counts a project whose reindex is in flight, and clears it after', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });

    expect(countReindexingProjects()).toBe(0);

    const pending = handleReindexFile(
      { project: root, path: `${root}/package.json` },
      {
        getProject: () => ({
          status: 'ready',
          pipeline: {
            indexFiles: async () => {
              entered();
              await gate;
              return { indexed: 1, skipped: 0, durationMs: 1 };
            },
          } as never,
        }),
        lock: (async (_o: unknown, fn: () => unknown) => await fn()) as never,
      },
    );

    await started;
    // The project is still `ready` — this is exactly the state that used to
    // read as idle.
    expect(countReindexingProjects()).toBe(1);

    release();
    await pending;
    expect(countReindexingProjects()).toBe(0);
  });

  it('releases the count when the reindex throws', async () => {
    await handleReindexFile(
      { project: root, path: `${root}/tsconfig.json` },
      {
        getProject: () => ({
          status: 'ready',
          pipeline: {
            indexFiles: () => {
              throw new Error('boom');
            },
          } as never,
        }),
        lock: (async (_o: unknown, fn: () => unknown) => await fn()) as never,
      },
    );
    expect(countReindexingProjects()).toBe(0);
  });
});
