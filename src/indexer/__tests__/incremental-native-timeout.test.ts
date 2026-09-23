/**
 * TRA-1843: the native watcher calls inside incremental discovery had no
 * bound — a wedged `@parcel/watcher` held an initial `indexAll` inside
 * `tryIncrementalDiscovery`'s since-query forever (0% CPU, zero pipeline
 * lines), leaking both shared `indexAllLimit` slots so every later `indexAll`
 * queued behind them.
 *
 * A since-query that does not answer must fall back to the full walk, and a
 * snapshot write that does not answer must report failure (both are covered
 * by the walk path), never hold the run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  sinceMode: 'hang' as 'hang' | 'ok',
  snapshotMode: 'hang' as 'hang' | 'ok',
}));

vi.mock('@parcel/watcher', () => ({
  getEventsSince: (_root: string, _snapshot: string, _opts?: unknown) => {
    if (mockState.sinceMode === 'hang') return new Promise(() => {});
    return Promise.resolve([]);
  },
  writeSnapshot: (_root: string, _snapshot: string, _opts?: unknown) => {
    if (mockState.snapshotMode === 'hang') return new Promise(() => {});
    return Promise.resolve();
  },
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

const {
  queryWatcherSince,
  writeWatcherSnapshot,
  setWatcherNativeTimeoutForTests,
  resetWatcherNativeTimeoutForTests,
} = await import('../incremental-discovery.js');

describe('incremental discovery — wedged native watcher (TRA-1843)', () => {
  let dir: string;
  let snapshot: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incr-native-timeout-'));
    snapshot = path.join(dir, 'watcher-snapshot');
    fs.writeFileSync(snapshot, 'opaque');
    mockState.sinceMode = 'hang';
    mockState.snapshotMode = 'hang';
    setWatcherNativeTimeoutForTests(50);
  });

  afterEach(() => {
    resetWatcherNativeTimeoutForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a hanging since-query falls back (null) instead of holding the run', async () => {
    await expect(queryWatcherSince(dir, snapshot)).resolves.toBeNull();
  });

  it('a hanging snapshot write reports failure instead of holding the run', async () => {
    await expect(writeWatcherSnapshot(dir, snapshot)).resolves.toBe(false);
  });

  it('healthy native answers still flow through', async () => {
    mockState.sinceMode = 'ok';
    mockState.snapshotMode = 'ok';
    await expect(queryWatcherSince(dir, snapshot)).resolves.toEqual({
      changedAbs: [],
      deletedAbs: [],
    });
    await expect(writeWatcherSnapshot(dir, snapshot)).resolves.toBe(true);
  });
});
