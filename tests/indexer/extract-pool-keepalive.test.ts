/**
 * ExtractPool keepAlive flag — daemon mode keeps workers warm across bursty
 * edits, but releases them after a long idle window (TRA-811). Covers Phase 2.2.
 */
import { describe, expect, it, vi } from 'vitest';
import { ExtractPool, KEEPALIVE_IDLE_TERMINATE_MS } from '../../src/indexer/extract-pool.js';

describe('ExtractPool — keepAlive option', () => {
  it('defaults to keepAlive=false (legacy behavior)', () => {
    const p = new ExtractPool();
    expect(p.keepAlive).toBe(false);
  });

  it('keepAlive=true is honored and changes the default size cap', () => {
    const cliPool = new ExtractPool({ keepAlive: false });
    const daemonPool = new ExtractPool({ keepAlive: true });
    expect(cliPool.keepAlive).toBe(false);
    expect(daemonPool.keepAlive).toBe(true);
    // Daemon default is half cores capped at 4; CLI default is cpus-1 capped at 8.
    // On any sane host the daemon cap should be ≤ the CLI cap.
    expect(daemonPool.size).toBeLessThanOrEqual(4);
    expect(daemonPool.size).toBeGreaterThanOrEqual(1);
  });

  it('explicit size wins over both defaults', () => {
    const a = new ExtractPool({ keepAlive: true, size: 7 });
    const b = new ExtractPool({ keepAlive: false, size: 7 });
    expect(a.size).toBe(7);
    expect(b.size).toBe(7);
  });

  it('legacy positional-int constructor still works', () => {
    const p = new ExtractPool(3);
    expect(p.size).toBe(3);
    expect(p.keepAlive).toBe(false);
  });

  it('keepAlive=true still schedules teardown, just on a much longer delay (TRA-811)', async () => {
    type WithPrivate = ExtractPool & {
      idleTimer: NodeJS.Timeout | null;
      scheduleIdleTeardown: () => void;
      idleTeardown: () => Promise<void>;
    };
    vi.useFakeTimers();
    try {
      const daemon = new ExtractPool({ keepAlive: true }) as WithPrivate;
      const cli = new ExtractPool({ keepAlive: false }) as WithPrivate;
      const daemonTeardown = vi.spyOn(daemon, 'idleTeardown').mockResolvedValue();
      const cliTeardown = vi.spyOn(cli, 'idleTeardown').mockResolvedValue();
      // idleTeardown only fires when workers exist — fake one slot each.
      const fakeWorker = (): unknown => ({ terminate: async () => 0, removeAllListeners() {} });
      (daemon as unknown as { workers: unknown[] }).workers = [fakeWorker()];
      (cli as unknown as { workers: unknown[] }).workers = [fakeWorker()];

      // Direct invocation — we don't need real worker threads to verify the
      // teardown gate, only that both pools arm a timer with the right delay.
      daemon.scheduleIdleTeardown();
      cli.scheduleIdleTeardown();
      expect(daemon.idleTimer).not.toBeNull();
      expect(cli.idleTimer).not.toBeNull();

      // Short window: CLI has already released, the daemon has not.
      await vi.advanceTimersByTimeAsync(1000);
      expect(cliTeardown).toHaveBeenCalledTimes(1);
      expect(daemonTeardown).not.toHaveBeenCalled();

      // The daemon releases once the long idle window elapses — this is the
      // behavior change: keepAlive no longer means "hold the workers forever".
      await vi.advanceTimersByTimeAsync(KEEPALIVE_IDLE_TERMINATE_MS);
      expect(daemonTeardown).toHaveBeenCalledTimes(1);

      await daemon.terminate();
      await cli.terminate();
    } finally {
      vi.useRealTimers();
    }
  });

  it('idleTeardown detaches listeners before terminating (TRA-811)', async () => {
    // The released workers' 'exit' is meaningless, and by the time it lands the
    // slot may hold a new worker that onExit would kill as a crash.
    const detached: boolean[] = [];
    const pool = new ExtractPool({ keepAlive: true }) as ExtractPool & {
      workers: unknown[];
      idleTeardown: () => Promise<void>;
    };
    pool.workers = [0, 1].map((i) => ({
      removeAllListeners() {
        detached[i] = true;
      },
      terminate: async () => {
        expect(detached[i]).toBe(true);
        return 0;
      },
    }));
    await pool.idleTeardown();
    expect(detached).toEqual([true, true]);
  });

  it('re-arms the idle timer when a batch ends in a rejection (TRA-811)', () => {
    // Only onMessage used to call scheduleIdleTeardown, so a failing batch left
    // the pool resident with no timer until the next successful extract().
    const pool = new ExtractPool({ keepAlive: true }) as ExtractPool & {
      slots: unknown[];
      workers: unknown[];
      pending: Map<number, { reject: (e: Error) => void }>;
      idleTimer: NodeJS.Timeout | null;
      onError: (idx: number, err: Error) => void;
    };
    pool.slots = [{ consecutiveFailures: 0, suppressedCount: 0, respawnTimer: null }];
    pool.workers = [{ terminate: async () => 0 }];
    pool.pending.set(1, { reject: () => {} });
    expect(pool.idleTimer).toBeNull();
    pool.onError(0, new Error('boom'));
    expect(pool.pending.size).toBe(0);
    expect(pool.idleTimer).not.toBeNull();
    clearTimeout(pool.idleTimer as NodeJS.Timeout);
  });
});
