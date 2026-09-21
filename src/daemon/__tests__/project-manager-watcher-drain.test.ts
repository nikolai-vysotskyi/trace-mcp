/**
 * TRA-1017 (review finding 3): the watcher drain must not bypass the
 * initial-index timeout.
 *
 * `stopProject()` used to `await watcher.stop()` — full unsubscribe + drain —
 * before reaching the bounded index wait. But `FileWatcher.stop()` awaits
 * in-flight handlers, and a handler queued on the pipeline lock behind the
 * minutes-long initial index settles only when that index does: the new
 * timeout sat behind the very wait it was meant to bound, and shutdown still
 * overran. `stopProject()` now unsubscribes fast up front and drains the
 * handlers inside the same bounded wait as the index itself.
 *
 * Uses a real FileWatcher (never started — no native subscription) with a
 * handler queued behind a never-settling initial index, under fake timers:
 * the stop must settle once the shared budget elapses, with the DB closed,
 * without the index ever being released.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../../db/schema.js';
import { FileWatcher } from '../../indexer/watcher.js';
import { ProjectManager } from '../project-manager.js';
import { STOP_PROJECT_INDEX_WAIT_MS } from '../project-manager.js';

let tmpRoot: string;
let db: Database.Database;

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* best-effort — the test asserts on open state, close may already run */
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('ProjectManager.stopProject watcher/index shared budget (TRA-1017)', () => {
  it('settles once the budget elapses with a handler queued behind a hung index', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'trace-mcp-watcher-drain-'));
    db = initializeDatabase(join(tmpRoot, 'index.db'));

    const watcher = new FileWatcher();
    let releaseIndex!: () => void;
    const initial = new Promise<void>((resolve) => {
      releaseIndex = resolve;
    });
    // A watcher callback queued on the same pipeline lock as initial
    // indexing — in production an indexFiles batch awaiting `_lock`.
    // biome-ignore lint/suspicious/noExplicitAny: reaching into watcher internals for the test
    (watcher as any).activeHandlers.add(initial.then(() => undefined));

    const pm = new ProjectManager();
    const controller = new AbortController();
    const managed = {
      root: tmpRoot,
      db,
      watcher,
      initialIndexPromise: initial,
      indexAbortController: controller,
      serverHandle: { dispose() {} },
      server: {
        async close() {},
      },
      pipeline: {
        async dispose() {},
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: bypassing private state for behavioural test
    (pm as any).projects.set(tmpRoot, managed);

    vi.useFakeTimers();
    let settled = false;
    // biome-ignore lint/suspicious/noExplicitAny: stopProject is private
    const stopped = (pm as any).stopProject(tmpRoot).then(() => {
      settled = true;
    });
    try {
      // Past the whole shutdown deadline, let alone the shared drain budget:
      // the stop must have given up waiting and torn down anyway.
      await vi.advanceTimersByTimeAsync(20_001);
      expect(controller.signal.aborted).toBe(true);
      expect(settled).toBe(true);
      expect(db.open).toBe(false);
    } finally {
      releaseIndex();
      await stopped;
      vi.useRealTimers();
    }
  }, 30_000);

  it('STOP_PROJECT_INDEX_WAIT_MS fits the shutdown deadline with the other phases', () => {
    // 5s reindex drain + shared drain + 5s dispose drain + synchronous
    // closes must stay inside DAEMON_SHUTDOWN_DEADLINE_MS (20s). If any of
    // the three budgets moves, this names the arithmetic to re-check.
    expect(5_000 + STOP_PROJECT_INDEX_WAIT_MS + 5_000).toBeLessThan(20_000);
  });
});
