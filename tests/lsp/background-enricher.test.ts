/**
 * Tests for BackgroundLspEnricher — Phase 3 of the indexer-perf plan.
 *
 * Contract:
 *   - rapid scheduleEnrichment() calls within debounceMs coalesce into ONE flush
 *   - scheduleEnrichment() during an in-flight flush queues IDs and triggers
 *     a follow-up flush after the first completes (no dropped IDs)
 *   - cancel() drops pending IDs and aborts the in-flight signal
 *   - errors thrown by the runner are caught and logged, never propagated
 *
 * Tests inject a fake runner via the `runner` constructor option so we never
 * spin up a real LSP server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TraceMcpConfig } from '../../src/config.js';
import type { Store } from '../../src/db/store.js';
import {
  BackgroundLspEnricher,
  type LspEnrichmentRunner,
} from '../../src/lsp/background-enricher.js';

/** Stub config — only `lsp.enabled` matters for the default runner path,
 *  and we always inject a fake runner so the field never gets read. */
function makeConfig(): TraceMcpConfig {
  return { lsp: { enabled: true } } as unknown as TraceMcpConfig;
}

/** Stub store — never accessed by the fake runner. */
const fakeStore = {} as unknown as Store;

describe('BackgroundLspEnricher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid scheduleEnrichment calls into one flush', async () => {
    const seenBatches: Array<Set<number>> = [];
    const runner: LspEnrichmentRunner = async ({ changedFileIds }) => {
      seenBatches.push(new Set(changedFileIds));
    };
    const enricher = new BackgroundLspEnricher({
      store: fakeStore,
      config: makeConfig(),
      rootPath: '/fake',
      debounceMs: 50,
      runner,
    });

    enricher.scheduleEnrichment([1]);
    enricher.scheduleEnrichment([2]);
    enricher.scheduleEnrichment([3]);
    enricher.scheduleEnrichment([2]); // duplicate — should still be one flush

    expect(seenBatches.length).toBe(0); // not yet — debounce pending

    await vi.advanceTimersByTimeAsync(60);
    // Allow the runner promise + finally re-entry guard to settle.
    await Promise.resolve();

    expect(seenBatches.length).toBe(1);
    expect([...seenBatches[0]].sort()).toEqual([1, 2, 3]);
  });

  it('queues IDs that arrive during an in-flight flush and runs a follow-up', async () => {
    let resolveFirst!: () => void;
    const firstStarted = new Promise<void>((r) => (resolveFirst = r));
    let blockFirst!: Promise<void>;
    const seenBatches: Array<Set<number>> = [];
    let call = 0;
    const runner: LspEnrichmentRunner = async ({ changedFileIds }) => {
      call++;
      seenBatches.push(new Set(changedFileIds));
      if (call === 1) {
        resolveFirst();
        await blockFirst;
      }
    };
    blockFirst = new Promise<void>(() => {
      /* never resolves until we release it manually below */
    });
    let releaseFirst!: () => void;
    blockFirst = new Promise<void>((r) => (releaseFirst = r));

    const enricher = new BackgroundLspEnricher({
      store: fakeStore,
      config: makeConfig(),
      rootPath: '/fake',
      debounceMs: 50,
      runner,
    });

    // First burst → first flush starts
    enricher.scheduleEnrichment([10, 11]);
    await vi.advanceTimersByTimeAsync(60);
    await firstStarted;
    expect(enricher.isRunning).toBe(true);
    expect(seenBatches.length).toBe(1);
    expect([...seenBatches[0]].sort()).toEqual([10, 11]);

    // Second burst arrives while first is still running
    enricher.scheduleEnrichment([20]);
    enricher.scheduleEnrichment([21]);
    // The IDs should be queued in pendingDuringRun, not the consumed set.
    expect(seenBatches.length).toBe(1);
    expect(enricher.pendingSize).toBe(2);

    // Release the first run; the follow-up should be auto-armed.
    releaseFirst();
    // Wait for the first runner's await chain to settle and re-arm.
    await Promise.resolve();
    await Promise.resolve();
    // Now advance past the debounce again to fire the follow-up flush.
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();

    expect(seenBatches.length).toBe(2);
    expect([...seenBatches[1]].sort()).toEqual([20, 21]);
  });

  it('cancel() drops pending IDs and aborts the in-flight signal', async () => {
    let observedSignal: AbortSignal | null = null;
    let started!: () => void;
    const startedPromise = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const releasePromise = new Promise<void>((r) => (release = r));
    const runner: LspEnrichmentRunner = async ({ signal }) => {
      observedSignal = signal;
      started();
      await releasePromise;
    };
    const enricher = new BackgroundLspEnricher({
      store: fakeStore,
      config: makeConfig(),
      rootPath: '/fake',
      debounceMs: 50,
      runner,
    });

    // Trigger a flush and let it start
    enricher.scheduleEnrichment([1, 2]);
    await vi.advanceTimersByTimeAsync(60);
    await startedPromise;

    // Queue more IDs during the in-flight run, then cancel
    enricher.scheduleEnrichment([3, 4]);
    expect(enricher.pendingSize).toBe(2);

    enricher.cancel();
    expect(enricher.pendingSize).toBe(0);
    expect(observedSignal).not.toBeNull();
    expect((observedSignal as unknown as AbortSignal).aborted).toBe(true);

    // After cancel, scheduling more IDs is a no-op (disposed)
    enricher.scheduleEnrichment([99]);
    expect(enricher.pendingSize).toBe(0);

    // Let the original runner finish so we don't leak the promise.
    release();
    await Promise.resolve();
    await Promise.resolve();
    // No follow-up flush should have happened (disposed).
    expect(enricher.isRunning).toBe(false);
  });

  it('catches runner errors and continues (never throws out)', async () => {
    let calls = 0;
    const runner: LspEnrichmentRunner = async () => {
      calls++;
      throw new Error('simulated LSP server crash');
    };
    const enricher = new BackgroundLspEnricher({
      store: fakeStore,
      config: makeConfig(),
      rootPath: '/fake',
      debounceMs: 50,
      runner,
    });

    enricher.scheduleEnrichment([1]);
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();
    // The flush should have happened, errored, and not propagated.
    expect(calls).toBe(1);
    expect(enricher.isRunning).toBe(false);
    expect(enricher.pendingSize).toBe(0);

    // A second burst should still run — the enricher recovers.
    enricher.scheduleEnrichment([2]);
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  it('flush() bypasses the debounce timer', async () => {
    const seenBatches: Array<Set<number>> = [];
    const runner: LspEnrichmentRunner = async ({ changedFileIds }) => {
      seenBatches.push(new Set(changedFileIds));
    };
    const enricher = new BackgroundLspEnricher({
      store: fakeStore,
      config: makeConfig(),
      rootPath: '/fake',
      debounceMs: 10_000, // would never fire without explicit flush()
      runner,
    });

    enricher.scheduleEnrichment([7]);
    expect(seenBatches.length).toBe(0);
    await enricher.flush();
    expect(seenBatches.length).toBe(1);
    expect([...seenBatches[0]]).toEqual([7]);
  });

  it('does nothing when scheduled with an empty ID iterable', async () => {
    let calls = 0;
    const runner: LspEnrichmentRunner = async () => {
      calls++;
    };
    const enricher = new BackgroundLspEnricher({
      store: fakeStore,
      config: makeConfig(),
      rootPath: '/fake',
      debounceMs: 20,
      runner,
    });

    enricher.scheduleEnrichment([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(0);
    expect(enricher.pendingSize).toBe(0);
  });
});
