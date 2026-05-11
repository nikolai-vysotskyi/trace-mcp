/**
 * ExtractPool keepAlive flag — daemon mode skips idle teardown so workers
 * stay warm across bursty edits. Covers Phase 2.2.
 */
import { describe, expect, it } from 'vitest';
import { ExtractPool } from '../../src/indexer/extract-pool.js';

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

  it('keepAlive=true skips scheduleIdleTeardown — pool survives idle window', async () => {
    type WithPrivate = ExtractPool & {
      idleTimer: NodeJS.Timeout | null;
      scheduleIdleTeardown: () => void;
    };
    const daemon = new ExtractPool({ keepAlive: true }) as WithPrivate;
    const cli = new ExtractPool({ keepAlive: false }) as WithPrivate;

    // Direct invocation — we don't need real worker threads to verify the
    // teardown gate; the public idleTimer is set only when keepAlive is false.
    daemon.scheduleIdleTeardown();
    cli.scheduleIdleTeardown();

    expect(daemon.idleTimer).toBeNull();
    expect(cli.idleTimer).not.toBeNull();

    // Cleanup CLI timer so vitest doesn't see a dangling handle.
    if (cli.idleTimer) {
      clearTimeout(cli.idleTimer);
      cli.idleTimer = null;
    }

    await daemon.terminate();
    await cli.terminate();
  });
});
