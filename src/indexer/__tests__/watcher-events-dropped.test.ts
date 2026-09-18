/**
 * TRA-852: when the OS drops fs events ("Events were dropped by the FSEvents
 * client. File system must be re-scanned."), the watcher used to log and
 * return — every change in the lost window stayed invisible to the index
 * forever. It must now run the reconcile pass instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as parcelWatcher from '@parcel/watcher';

type Callback = (err: Error | null, events: parcelWatcher.Event[]) => void | Promise<void>;

let capturedCallback: Callback | null = null;

vi.mock('@parcel/watcher', () => ({
  subscribe: async (_root: string, cb: Callback) => {
    capturedCallback = cb;
    return { unsubscribe: async () => {} };
  },
}));

const { FileWatcher, getDroppedEventStats, resetDroppedEventStats } = await import('../watcher.js');

async function startWatcher(onRescan?: () => Promise<void>) {
  const watcher = new FileWatcher();
  await watcher.start(process.cwd(), {} as never, async () => {}, 10, undefined, { onRescan });
  return watcher;
}

describe('FileWatcher — dropped fs events', () => {
  it('runs the reconcile pass when events were dropped', async () => {
    const onRescan = vi.fn(async () => {});
    const watcher = await startWatcher(onRescan);

    await capturedCallback!(
      new Error('Events were dropped by the FSEvents client. File system must be re-scanned.'),
      [],
    );

    expect(onRescan).toHaveBeenCalledTimes(1);
    await watcher.stop();
  });

  it('does not reconcile on unrelated watcher errors', async () => {
    const onRescan = vi.fn(async () => {});
    const watcher = await startWatcher(onRescan);

    await capturedCallback!(new Error('some other watcher failure'), []);

    expect(onRescan).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it('collapses a burst of drops into one in-flight pass plus one follow-up', async () => {
    let release: () => void = () => {};
    const onRescan = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const watcher = await startWatcher(onRescan);
    const dropped = new Error('Events were dropped by the FSEvents client.');

    await capturedCallback!(dropped, []);
    await capturedCallback!(dropped, []);
    await capturedCallback!(dropped, []);
    expect(onRescan).toHaveBeenCalledTimes(1);

    const first = release;
    first();
    await vi.waitFor(() => expect(onRescan).toHaveBeenCalledTimes(2));
    release();
    await watcher.stop();
  });

  it('stop() waits for an in-flight reconcile — callers dispose the pipeline right after', async () => {
    let release: () => void = () => {};
    const onRescan = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const watcher = await startWatcher(onRescan);
    await capturedCallback!(new Error('Events were dropped by the FSEvents client.'), []);

    let stopped = false;
    const stopping = watcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});

/**
 * TRA-813 asked for a counter on top of the repair: without one a later run
 * cannot tell "the OS never dropped anything" from "it dropped events and the
 * repair was silently skipped". `get_index_health` reads this tally.
 */
describe('FileWatcher — dropped-event tally', () => {
  beforeEach(() => resetDroppedEventStats());

  it('counts every drop report and every reconcile pass it starts', async () => {
    const onRescan = vi.fn(async () => {});
    const watcher = await startWatcher(onRescan);
    const dropped = new Error('Events were dropped by the FSEvents client.');

    await capturedCallback!(dropped, []);
    await capturedCallback!(dropped, []);

    expect(getDroppedEventStats()).toEqual({ drops: 2, reconciles: 2, suppressed: 0 });
    await watcher.stop();
  });

  it('counts the drop even when no reconcile callback is wired', async () => {
    const watcher = await startWatcher(undefined);

    await capturedCallback!(new Error('Events were dropped by the FSEvents client.'), []);

    expect(getDroppedEventStats()).toEqual({ drops: 1, reconciles: 0, suppressed: 0 });
    await watcher.stop();
  });

  it('leaves the tally alone for unrelated watcher errors', async () => {
    const watcher = await startWatcher(vi.fn(async () => {}));

    await capturedCallback!(new Error('EMFILE: too many open files'), []);

    expect(getDroppedEventStats()).toEqual({ drops: 0, reconciles: 0, suppressed: 0 });
    await watcher.stop();
  });
});

/**
 * TRA-1665: a watcher on a churn-heavy dir (build/ML run artifacts written
 * continuously) used to run one full-walk reconcile per dropped-events report
 * — a per-minute 10k-file walk for as long as the run lasted. The storm
 * breaker collapses sustained drops into one trailing pass per cooldown.
 */
describe('FileWatcher — reconcile storm backoff', () => {
  beforeEach(() => resetDroppedEventStats());

  interface StormHarness {
    watcher: InstanceType<typeof FileWatcher>;
    advance: (ms: number) => void;
    fireStormTimer: () => void;
    hasStormTimer: () => boolean;
  }

  async function startStormWatcher(onRescan: () => Promise<void>): Promise<StormHarness> {
    let now = 1_000_000;
    let timerCb: (() => void) | null = null;
    // Deterministic timer: the debounce path is unused in these tests (no
    // change events fire), so capturing the storm timer callback is enough.
    const fakeSetTimeout = ((cb: () => void) => {
      timerCb = cb;
      return {} as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout;
    const fakeClearTimeout = (() => {
      timerCb = null;
    }) as unknown as typeof clearTimeout;
    const watcher = new FileWatcher(fakeSetTimeout, fakeClearTimeout, {
      now: () => now,
      stormWindowMs: 300_000,
      stormThreshold: 3,
      stormCooldownMs: 300_000,
    });
    await watcher.start(process.cwd(), {} as never, async () => {}, 10, undefined, { onRescan });
    return {
      watcher,
      advance: (ms: number) => {
        now += ms;
      },
      fireStormTimer: () => {
        // A real setTimeout fires once — consume the callback like it does.
        const cb = timerCb;
        timerCb = null;
        cb?.();
      },
      hasStormTimer: () => timerCb !== null,
    };
  }

  const dropped = () => new Error('Events were dropped by the FSEvents client.');

  it('runs isolated drops immediately without engaging the breaker', async () => {
    const onRescan = vi.fn(async () => {});
    const h = await startStormWatcher(onRescan);

    await capturedCallback!(dropped(), []);
    h.advance(60_000);
    await capturedCallback!(dropped(), []);

    expect(onRescan).toHaveBeenCalledTimes(2);
    expect(getDroppedEventStats()).toEqual({ drops: 2, reconciles: 2, suppressed: 0 });
    expect(h.hasStormTimer()).toBe(false);
    await h.watcher.stop();
  });

  it('collapses a sustained storm into one trailing pass per cooldown', async () => {
    const onRescan = vi.fn(async () => {});
    const h = await startStormWatcher(onRescan);

    // Three drops inside the window: each is still honored with a walk (the
    // in-flight collapse may fold one into a follow-up — wait it out), but
    // the third opens the breaker.
    await capturedCallback!(dropped(), []);
    h.advance(60_000);
    await capturedCallback!(dropped(), []);
    h.advance(60_000);
    await capturedCallback!(dropped(), []);
    await vi.waitFor(() => expect(onRescan).toHaveBeenCalledTimes(3));

    // The storm tail: two more drops, no more walks — one pending pass.
    h.advance(60_000);
    await capturedCallback!(dropped(), []);
    h.advance(60_000);
    await capturedCallback!(dropped(), []);
    expect(onRescan).toHaveBeenCalledTimes(3);
    expect(getDroppedEventStats()).toEqual({ drops: 5, reconciles: 3, suppressed: 2 });
    expect(h.hasStormTimer()).toBe(true);

    // Cooldown elapses: exactly one trailing walk covers the whole tail.
    h.fireStormTimer();
    await vi.waitFor(() => expect(onRescan).toHaveBeenCalledTimes(4));
    expect(getDroppedEventStats()).toEqual({ drops: 5, reconciles: 4, suppressed: 2 });

    // Breaker closed again: the next drop reconciles immediately.
    h.advance(60_000);
    await capturedCallback!(dropped(), []);
    await vi.waitFor(() => expect(onRescan).toHaveBeenCalledTimes(5));
    expect(h.hasStormTimer()).toBe(false);
    await h.watcher.stop();
  });

  it('stop() disarms the breaker — a suppressed storm never runs post-stop', async () => {
    const onRescan = vi.fn(async () => {});
    const h = await startStormWatcher(onRescan);

    await capturedCallback!(dropped(), []);
    h.advance(60_000);
    await capturedCallback!(dropped(), []);
    h.advance(60_000);
    await capturedCallback!(dropped(), []);
    h.advance(60_000);
    await capturedCallback!(dropped(), []);
    expect(onRescan).toHaveBeenCalledTimes(3);
    expect(h.hasStormTimer()).toBe(true);

    await h.watcher.stop();
    h.fireStormTimer();
    await new Promise((r) => setTimeout(r, 20));
    expect(onRescan).toHaveBeenCalledTimes(3);
  });
});
