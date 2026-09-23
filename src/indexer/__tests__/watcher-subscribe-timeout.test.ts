/**
 * TRA-1843: a native `watcher.subscribe()` that never answers used to wedge
 * `FileWatcher.start()` forever — and with it the two `loadAllRegistered`
 * setup slots, so the remaining eager projects never loaded and `/health`
 * reported `starting` indefinitely (87+ min, 0% CPU, zero pipeline lines).
 *
 * `start()` must fail fast past WATCHER_SUBSCRIBE_TIMEOUT_MS instead, and a
 * native subscription that resolves after the timeout must be dropped at
 * once rather than leaking as an untracked live fs-event handle.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'hang' | 'late',
  lateDelayMs: 0,
  unsubscribed: 0,
}));

vi.mock('@parcel/watcher', () => ({
  subscribe: (_root: string, _cb: unknown) => {
    if (mockState.mode === 'hang') {
      return new Promise(() => {});
    }
    if (mockState.mode === 'late') {
      return new Promise((resolve) => {
        setTimeout(
          () => resolve({ unsubscribe: async () => void mockState.unsubscribed++ }),
          mockState.lateDelayMs,
        );
      });
    }
    return Promise.resolve({ unsubscribe: async () => {} });
  },
}));

const { FileWatcher, setWatcherSubscribeTimeoutForTests, resetWatcherSubscribeTimeoutForTests } =
  await import('../watcher.js');

describe('FileWatcher.start() — wedged native subscribe (TRA-1843)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-subscribe-timeout-'));
    mockState.mode = 'ok';
    mockState.lateDelayMs = 0;
    mockState.unsubscribed = 0;
    setWatcherSubscribeTimeoutForTests(50);
  });

  afterEach(() => {
    resetWatcherSubscribeTimeoutForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects instead of hanging when subscribe never answers', async () => {
    mockState.mode = 'hang';
    const watcher = new FileWatcher();

    await expect(watcher.start(root, {} as never, async () => {})).rejects.toThrow(
      /subscribe timed out.*TRA-1843/,
    );
  });

  it('unsubscribes a native subscription that resolves after the timeout', async () => {
    mockState.mode = 'late';
    mockState.lateDelayMs = 150;
    const watcher = new FileWatcher();

    await expect(watcher.start(root, {} as never, async () => {})).rejects.toThrow(
      /subscribe timed out/,
    );
    // Let the late native subscription land — it must be dropped at once.
    await new Promise((r) => setTimeout(r, 300));
    expect(mockState.unsubscribed).toBe(1);
    // The timed-out start assigned nothing trackable.
    await watcher.stop();
  });

  it('still starts normally when subscribe answers in time', async () => {
    const watcher = new FileWatcher();
    await watcher.start(root, {} as never, async () => {});
    await watcher.stop();
  });
});
