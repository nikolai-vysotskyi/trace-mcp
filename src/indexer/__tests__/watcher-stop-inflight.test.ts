import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TRA-808: `stop()` used to return while a debounce callback that had already
 * fired was still awaiting `onChanges`. ProjectManager.stopProject() calls
 * `watcher.stop()` and then `db.close()`, so that in-flight reindex kept
 * running against a closed SQLite handle — 206 `The database connection is not
 * open` errors in the field daemon log, every one of them a file change that
 * silently never landed in the index.
 */

let capturedCallback: ((err: Error | null, events: unknown[]) => void) | undefined;

vi.mock('@parcel/watcher', () => ({
  subscribe: async (_root: string, cb: (err: Error | null, events: unknown[]) => void) => {
    capturedCallback = cb;
    return { unsubscribe: async () => {} };
  },
}));

const { FileWatcher } = await import('../watcher.js');

describe('FileWatcher.stop() with an in-flight change handler', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-inflight-'));
    capturedCallback = undefined;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('waits for a handler that already started before resolving', async () => {
    const watcher = new FileWatcher();
    let finished = false;
    let started = false;

    await watcher.start(
      root,
      {} as never,
      async () => {
        started = true;
        await new Promise((r) => setTimeout(r, 50));
        finished = true;
      },
      1,
    );

    capturedCallback?.(null, [{ type: 'update', path: path.join(root, 'a.ts') }]);
    // Let the 1 ms debounce fire so onChanges is genuinely mid-flight.
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(true);
    expect(finished).toBe(false);

    await watcher.stop();
    expect(finished).toBe(true);
  });

  it('waits for an in-flight delete handler too', async () => {
    const watcher = new FileWatcher();
    let finished = false;

    await watcher.start(
      root,
      {} as never,
      async () => {},
      1,
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        finished = true;
      },
    );

    capturedCallback?.(null, [{ type: 'delete', path: path.join(root, 'a.ts') }]);
    await new Promise((r) => setTimeout(r, 5));

    await watcher.stop();
    expect(finished).toBe(true);
  });
});
