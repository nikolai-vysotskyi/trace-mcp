import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PollingDaemonWatcher } from '../../src/daemon/router/daemon-watcher.js';

// Mock the daemon client module so we can control what isDaemonRunning returns.
vi.mock('../../src/daemon/client.js', () => {
  return {
    isDaemonRunning: vi.fn(async () => false),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
import * as daemonClient from '../../src/daemon/client.js';

const mocked = vi.mocked(daemonClient.isDaemonRunning);

describe('PollingDaemonWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocked.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports initial state on start without debounce', async () => {
    mocked.mockResolvedValue(true);
    const w = new PollingDaemonWatcher({ port: 1234, pollIntervalMs: 100, stabilityMs: 500 });
    await w.start();
    expect(w.getCurrentState()).toBe(true);
    w.stop();
  });

  it('emits stable change only after stabilityMs of consistent new state', async () => {
    mocked.mockResolvedValue(false); // initial
    const w = new PollingDaemonWatcher({ port: 1234, pollIntervalMs: 100, stabilityMs: 300 });
    const seen: boolean[] = [];
    w.onStableChange((s) => seen.push(s));
    await w.start();
    expect(w.getCurrentState()).toBe(false);

    // Flip to true in the mock, then advance timers through several polls.
    mocked.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(100); // 1st poll observes true, starts stability timer
    await vi.advanceTimersByTimeAsync(100); // still true
    expect(seen).toEqual([]); // not yet stable
    await vi.advanceTimersByTimeAsync(200); // stability window elapsed
    expect(seen).toEqual([true]);
    expect(w.getCurrentState()).toBe(true);
    w.stop();
  });

  it('ignores a flap shorter than stabilityMs', async () => {
    mocked.mockResolvedValue(false);
    const w = new PollingDaemonWatcher({ port: 1234, pollIntervalMs: 50, stabilityMs: 300 });
    const seen: boolean[] = [];
    w.onStableChange((s) => seen.push(s));
    await w.start();

    // Flip to true for ~100ms then back to false.
    mocked.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    mocked.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(50); // observed false again
    await vi.advanceTimersByTimeAsync(500); // past stability window
    expect(seen).toEqual([]);
    expect(w.getCurrentState()).toBe(false);
    w.stop();
  });

  it('emits a second change when state stabilizes again in opposite direction', async () => {
    mocked.mockResolvedValue(true);
    const w = new PollingDaemonWatcher({ port: 1234, pollIntervalMs: 50, stabilityMs: 200 });
    const seen: boolean[] = [];
    w.onStableChange((s) => seen.push(s));
    await w.start();
    expect(w.getCurrentState()).toBe(true);

    mocked.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([false]);

    mocked.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([false, true]);
    w.stop();
  });

  it('stop() prevents any further callbacks', async () => {
    mocked.mockResolvedValue(false);
    const w = new PollingDaemonWatcher({ port: 1234, pollIntervalMs: 50, stabilityMs: 100 });
    const seen: boolean[] = [];
    w.onStableChange((s) => seen.push(s));
    await w.start();
    mocked.mockResolvedValue(true);
    w.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([]);
  });
});
