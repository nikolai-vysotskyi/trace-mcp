/**
 * Unit tests for the progress-throttle bookkeeping module.
 *
 * Two leak channels are covered:
 *
 *   1. Terminal pipeline events (`reindex_completed`, `reindex_errored`,
 *      `embed_completed`) must drop their corresponding throttle-map key.
 *      Pre-fix, completed pipelines pinned `${root}::${pipeline}` (or
 *      `${root}::embed`) keys forever inside an active project — the
 *      project-level teardown only fired on removeProject().
 *
 *   2. Passive sweep: when the throttle map grows past the soft cap, stale
 *      entries (older than 1 h) must be evicted inline on the next event.
 *      No timer, no async, no GC dependency.
 *
 * The module is pure (owns no globals) — tests construct their own Map and
 * call the helpers directly, identical to how cli.ts wires them.
 */

import { describe, expect, it } from 'vitest';

import {
  clearKeyForTerminalEvent,
  DEFAULT_PROGRESS_MAP_SOFT_CAP,
  DEFAULT_PROGRESS_STALE_MS,
  maybePruneOnHighWatermark,
  pruneStaleEntries,
  shouldEmitThrottledEvent,
  throttleKeyFor,
  type ThrottleAwareEvent,
} from '../../src/daemon/progress-throttle.js';

const PROJECT_A = '/Users/dev/projects/alpha';
const PROJECT_B = '/Users/dev/projects/beta';

describe('progress-throttle: terminal-event key cleanup', () => {
  it('drops the (project, pipeline) key on reindex_completed', () => {
    const map = new Map<string, number>();
    map.set(`${PROJECT_A}::pipeline1`, Date.now());
    map.set(`${PROJECT_A}::pipeline2`, Date.now());
    map.set(`${PROJECT_B}::pipeline1`, Date.now());

    const event: ThrottleAwareEvent = {
      type: 'reindex_completed',
      project: PROJECT_A,
      pipeline: 'pipeline1',
    };
    clearKeyForTerminalEvent(map, event);

    expect(map.has(`${PROJECT_A}::pipeline1`)).toBe(false);
    expect(map.has(`${PROJECT_A}::pipeline2`)).toBe(true); // sibling untouched
    expect(map.has(`${PROJECT_B}::pipeline1`)).toBe(true); // other project untouched
  });

  it('drops the (project, pipeline) key on reindex_errored', () => {
    const map = new Map<string, number>();
    map.set(`${PROJECT_A}::pipeline1`, Date.now());

    clearKeyForTerminalEvent(map, {
      type: 'reindex_errored',
      project: PROJECT_A,
      pipeline: 'pipeline1',
    });

    expect(map.has(`${PROJECT_A}::pipeline1`)).toBe(false);
  });

  it('drops the (project, embed) key on embed_completed', () => {
    const map = new Map<string, number>();
    map.set(`${PROJECT_A}::embed`, Date.now());
    map.set(`${PROJECT_A}::pipeline1`, Date.now());

    clearKeyForTerminalEvent(map, { type: 'embed_completed', project: PROJECT_A });

    expect(map.has(`${PROJECT_A}::embed`)).toBe(false);
    expect(map.has(`${PROJECT_A}::pipeline1`)).toBe(true); // non-embed key untouched
  });

  it('is a no-op for non-terminal events', () => {
    const map = new Map<string, number>();
    map.set(`${PROJECT_A}::pipeline1`, 123);

    clearKeyForTerminalEvent(map, {
      type: 'indexing_progress',
      project: PROJECT_A,
      pipeline: 'pipeline1',
    });

    expect(map.get(`${PROJECT_A}::pipeline1`)).toBe(123);
  });

  it('is idempotent — clearing a missing key does not throw', () => {
    const map = new Map<string, number>();
    expect(() =>
      clearKeyForTerminalEvent(map, {
        type: 'reindex_completed',
        project: PROJECT_A,
        pipeline: 'gone',
      }),
    ).not.toThrow();
    expect(map.size).toBe(0);
  });
});

describe('progress-throttle: passive high-watermark sweep', () => {
  it('does not prune when the map is at or below the soft cap', () => {
    const map = new Map<string, number>();
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      map.set(`p${i}`, now - 2 * DEFAULT_PROGRESS_STALE_MS); // ancient values
    }
    const removed = maybePruneOnHighWatermark(map, now);
    expect(removed).toBe(0);
    expect(map.size).toBe(10);
  });

  it('drops stale entries when the map exceeds the soft cap (one_hour threshold)', () => {
    const map = new Map<string, number>();
    const now = Date.now();
    // 1100 entries with old timestamps (>1h ago)
    const oldStamp = now - 2 * DEFAULT_PROGRESS_STALE_MS;
    for (let i = 0; i < 1100; i++) {
      map.set(`stale-${i}`, oldStamp);
    }
    // One new entry (current timestamp) — should survive.
    map.set(`fresh::${PROJECT_A}::pipeline1`, now);

    expect(map.size).toBeGreaterThan(DEFAULT_PROGRESS_MAP_SOFT_CAP);
    const removed = maybePruneOnHighWatermark(map, now);

    expect(removed).toBe(1100);
    expect(map.size).toBe(1);
    expect(map.has(`fresh::${PROJECT_A}::pipeline1`)).toBe(true);
  });

  it('pruneStaleEntries directly walks the whole map regardless of size', () => {
    const map = new Map<string, number>();
    const now = Date.now();
    map.set('stale', now - DEFAULT_PROGRESS_STALE_MS - 1);
    map.set('fresh', now);

    const removed = pruneStaleEntries(map, now, DEFAULT_PROGRESS_STALE_MS);

    expect(removed).toBe(1);
    expect(map.has('stale')).toBe(false);
    expect(map.has('fresh')).toBe(true);
  });
});

describe('progress-throttle: emit decision + key derivation', () => {
  it('throttleKeyFor returns the correct bucket key', () => {
    expect(
      throttleKeyFor({
        type: 'indexing_progress',
        project: PROJECT_A,
        pipeline: 'pipeline1',
      }),
    ).toBe(`${PROJECT_A}::pipeline1`);

    expect(throttleKeyFor({ type: 'embed_progress', project: PROJECT_A })).toBe(
      `${PROJECT_A}::embed`,
    );

    expect(
      throttleKeyFor({
        type: 'reindex_completed',
        project: PROJECT_A,
        pipeline: 'pipeline1',
      }),
    ).toBeNull();
  });

  it('shouldEmitThrottledEvent returns true on first call and false within the throttle window', () => {
    const map = new Map<string, number>();
    const event: ThrottleAwareEvent = {
      type: 'indexing_progress',
      project: PROJECT_A,
      pipeline: 'pipeline1',
    };
    const t0 = 1_000_000;
    expect(shouldEmitThrottledEvent(map, event, t0, 200)).toBe(true);
    expect(shouldEmitThrottledEvent(map, event, t0 + 50, 200)).toBe(false);
    expect(shouldEmitThrottledEvent(map, event, t0 + 250, 200)).toBe(true);
  });

  it('shouldEmitThrottledEvent always emits non-throttled events without touching the map', () => {
    const map = new Map<string, number>();
    expect(
      shouldEmitThrottledEvent(
        map,
        { type: 'reindex_completed', project: PROJECT_A, pipeline: 'pipeline1' },
        Date.now(),
        200,
      ),
    ).toBe(true);
    expect(map.size).toBe(0);
  });
});
