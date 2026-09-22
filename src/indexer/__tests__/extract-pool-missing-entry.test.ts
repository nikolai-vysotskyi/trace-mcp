/**
 * TRA-1807: when the install tree is deleted under a running daemon, the
 * extract worker entry is gone too. Spawning anyway crash-loops every slot
 * to its 5-failure budget (~20 `Extract worker crashed` lines); instead the
 * pool must emit one loud error, disable itself quietly, and fall back to
 * in-process extraction — and reanimate without a restart if the entry
 * reappears (transient delete / install racing daemon start).
 *
 * We drive the private spawn/tryRecover paths directly (no real Worker
 * threads); the Worker bridge is exercised elsewhere.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger.js';
import { ExtractPool, resetMissingWorkerEntryWarnForTests } from '../extract-pool.js';

interface SlotInternal {
  consecutiveFailures: number;
  permanentlyDead: boolean;
  respawnTimer: NodeJS.Timeout | null;
  lastErrorKey: string | null;
  suppressedCount: number;
  suppressedSince: number;
}

interface PoolInternals {
  workers: unknown[];
  slots: SlotInternal[];
  poolDisabled: boolean;
  size: number;
  workerEntry: URL | null;
  spawn: (idx: number) => void;
  makeSlot: () => SlotInternal;
  tryRecover: () => boolean;
}

function asInternals(p: ExtractPool): PoolInternals {
  return p as unknown as PoolInternals;
}

function seedSlots(p: ExtractPool, n: number): void {
  const internals = asInternals(p);
  internals.slots = [];
  for (let i = 0; i < n; i++) internals.slots.push(internals.makeSlot());
}

const MISSING_ENTRY = new URL('file:///definitely-not-here-1807/extract-worker.js');

describe('ExtractPool — missing worker entry (TRA-1807)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetMissingWorkerEntryWarnForTests();
    errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetMissingWorkerEntryWarnForTests();
  });

  it('marks slots dead on spawn with one loud error, no crash storm', () => {
    const pool = new ExtractPool({ keepAlive: true, size: 2, workerEntry: MISSING_ENTRY });
    seedSlots(pool, 2);
    const internals = asInternals(pool);

    internals.spawn(0);
    internals.spawn(1);

    expect(internals.slots[0].permanentlyDead).toBe(true);
    expect(internals.slots[1].permanentlyDead).toBe(true);
    expect(internals.poolDisabled).toBe(true);
    expect(pool.available).toBe(false);
    // One loud error for the whole pool (not ~20 crash lines), plus the
    // single pool-disabled summary warn.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][1])).toMatch(/TRA-1807/);
    const poolWarns = warnSpy.mock.calls.filter(([, m]: [unknown, unknown]) =>
      String(m).includes('permanently disabled'),
    );
    expect(poolWarns.length).toBe(1);
    // No respawn timers scheduled for dead slots.
    expect(internals.slots[0].respawnTimer).toBeNull();
    expect(internals.slots[1].respawnTimer).toBeNull();
  });

  it('extract() rejects cleanly once disabled on a missing entry', async () => {
    const pool = new ExtractPool({ keepAlive: true, size: 1, workerEntry: MISSING_ENTRY });
    seedSlots(pool, 1);
    asInternals(pool).spawn(0);
    expect(pool.available).toBe(false);

    await expect(
      pool.extract({
        relPath: 'src/x.ts',
        rootPath: '/p',
        force: false,
        existing: null,
        gitignored: false,
        workspaces: [],
      }),
    ).rejects.toThrow(/unavailable/i);
    await pool.terminate();
  });

  it('reanimates without a restart when the entry reappears', () => {
    const pool = new ExtractPool({ keepAlive: true, size: 1, workerEntry: MISSING_ENTRY });
    seedSlots(pool, 1);
    const internals = asInternals(pool);
    internals.spawn(0);
    expect(internals.poolDisabled).toBe(true);

    // The entry reappears (transient delete over, install finished).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-1807-pool-'));
    try {
      const entryFile = path.join(dir, 'extract-worker.js');
      fs.writeFileSync(entryFile, '// fake\n');
      internals.workerEntry = pathToFileURL(entryFile);

      expect(internals.tryRecover()).toBe(true);
      expect(internals.poolDisabled).toBe(false);
      expect(pool.available).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays disabled while the entry is still missing', () => {
    const pool = new ExtractPool({ keepAlive: true, size: 1, workerEntry: MISSING_ENTRY });
    seedSlots(pool, 1);
    const internals = asInternals(pool);
    internals.spawn(0);
    expect(internals.poolDisabled).toBe(true);

    expect(internals.tryRecover()).toBe(false);
    expect(internals.poolDisabled).toBe(true);
    expect(pool.available).toBe(false);
  });
});
