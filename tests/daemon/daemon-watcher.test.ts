import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { PollingDaemonWatcher } from '../../src/daemon/router/daemon-watcher.js';
import { MessageRouter } from '../../src/daemon/router/message-router.js';
import type { Backend } from '../../src/daemon/router/types.js';

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

  it('rechecks health before declaring the daemon disappeared after a stalled polling window', async () => {
    mocked.mockResolvedValue(true);
    const w = new PollingDaemonWatcher({ port: 1234, pollIntervalMs: 1000, stabilityMs: 300 });
    const seen: boolean[] = [];
    w.onStableChange((s) => seen.push(s));
    await w.start();

    mocked.mockResolvedValueOnce(false).mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(300);

    expect(mocked).toHaveBeenCalledTimes(3); // initial, missed health, confirmation
    expect(seen).toEqual([]);
    expect(w.getCurrentState()).toBe(true);
    w.stop();
  });

  it('discards an old confirmation after recovery starts a new outage window', async () => {
    mocked.mockResolvedValue(true);
    const w = new PollingDaemonWatcher({ port: 1234, pollIntervalMs: 100, stabilityMs: 50 });
    const seen: boolean[] = [];
    w.onStableChange((s) => seen.push(s));
    await w.start();

    let resolveOld: (state: boolean) => void = () => {};
    mocked.mockResolvedValueOnce(false).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOld = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(150); // first outage reaches its confirmation probe
    expect(mocked).toHaveBeenCalledTimes(3);

    mocked.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(50); // recovery cancels the first outage
    expect(mocked).toHaveBeenCalledTimes(4);
    mocked.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(100); // a new outage starts its own window
    expect(mocked).toHaveBeenCalledTimes(5);

    resolveOld(false); // stale result must not confirm the new window
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([]);
    expect(w.getCurrentState()).toBe(true);
    w.stop();
  });

  it('keeps a valid confirmation through another failed poll', async () => {
    mocked.mockResolvedValue(true);
    const w = new PollingDaemonWatcher({ port: 1234, pollIntervalMs: 100, stabilityMs: 50 });
    const seen: boolean[] = [];
    w.onStableChange((s) => seen.push(s));
    await w.start();

    let resolveConfirmation: (state: boolean) => void = () => {};
    mocked.mockResolvedValueOnce(false).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(150); // confirmation starts
    expect(mocked).toHaveBeenCalledTimes(3);
    mocked.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(50); // another failed poll during confirmation
    expect(mocked).toHaveBeenCalledTimes(4);

    resolveConfirmation(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([false]);
    w.stop();
  });

  it('keeps concurrent clients on the daemon through one missed health window', async () => {
    mocked.mockResolvedValue(true);
    const watchers = Array.from(
      { length: 31 },
      () => new PollingDaemonWatcher({ port: 1234, pollIntervalMs: 1000, stabilityMs: 300 }),
    );
    const fallbacks: boolean[] = [];
    const replies: number[] = [];
    const routers = watchers.map(() => {
      const router = new MessageRouter({
        sendToClient: (msg) => replies.push((msg as { id: number }).id),
      });
      const proxy: Backend = {
        kind: 'proxy',
        async start() {},
        async stop() {},
        async send(msg: JSONRPCMessage) {
          const id = (msg as { id?: number }).id;
          if (id !== undefined) {
            proxy.onmessage?.({ jsonrpc: '2.0', id, result: { servedBy: 'proxy' } });
          }
        },
      };
      router.setInitialBackend(proxy);
      return router;
    });
    const sendRound = async (offset: number) => {
      await Promise.all(
        routers.map((router, i) =>
          router.ingestFromClient({
            jsonrpc: '2.0',
            id: offset + i,
            method: 'ping',
            params: {},
          }),
        ),
      );
    };
    for (const watcher of watchers) {
      watcher.onStableChange((active) => {
        if (!active) fallbacks.push(active);
      });
    }
    await Promise.all(watchers.map((watcher) => watcher.start()));
    await sendRound(1);
    mocked.mockResolvedValueOnce(false);
    // Each client's first poll fails during the checkout-sized load spike.
    for (let i = 1; i < watchers.length; i++) mocked.mockResolvedValueOnce(false);
    mocked.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1300);
    await sendRound(32);

    expect(fallbacks).toHaveLength(0);
    expect(watchers.every((watcher) => watcher.getCurrentState())).toBe(true);
    expect(replies.sort((a, b) => a - b)).toEqual(Array.from({ length: 62 }, (_, i) => i + 1));
    watchers.forEach((watcher) => watcher.stop());
    await Promise.all(routers.map((router) => router.shutdown()));
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
