/**
 * Per-(project, pipeline) progress-event throttle bookkeeping.
 *
 * Extracted from `src/cli.ts` so the throttle map's lifecycle is unit-testable
 * without booting the full HTTP daemon. The module is deliberately pure:
 * it owns no globals — callers pass in the `Map<string, number>` whose
 * lifetime they already manage (cli.ts keeps it alive for the daemon's
 * lifetime; tests own short-lived instances).
 *
 * Three responsibilities:
 *   1. `throttleKeyFor(event)` — derive the bucket key for a throttle-eligible
 *      event variant. Returns `null` for events that should bypass the floor.
 *   2. `clearKeyForTerminalEvent(map, event)` — drop the bucket key when a
 *      terminal pipeline event (reindex_completed / reindex_errored /
 *      embed_completed) fires, so finished pipelines do not pin keys forever
 *      inside an active (non-removed) project.
 *   3. `pruneStaleEntries(map, now, maxAgeMs)` — cheap passive sweep used
 *      when the Map grows past a soft cap, to drop entries older than
 *      `maxAgeMs`. No timers, no async — runs inline at most once per event
 *      when the map exceeds the cap. The cap + age constants are exported as
 *      `DEFAULT_PROGRESS_*` so cli.ts and the tests agree on them.
 *
 * Behavior is identical to the inline version that previously lived in
 * cli.ts; this is a non-functional refactor plus two new behaviors (terminal
 * cleanup, passive sweep).
 */

/** Soft cap on entries before the passive sweep runs. */
export const DEFAULT_PROGRESS_MAP_SOFT_CAP = 1024;

/** Drop entries older than this during a passive sweep. */
export const DEFAULT_PROGRESS_STALE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Subset of the cli.ts `DaemonEvent` union that the throttle bookkeeping
 * cares about. Kept narrow so we don't drag the full union into this module
 * (cli.ts owns the SSE wire format).
 */
export type ThrottleAwareEvent =
  | { type: 'indexing_progress'; project: string; pipeline: string }
  | { type: 'embed_progress'; project: string }
  | { type: 'reindex_completed'; project: string; pipeline: string }
  | { type: 'reindex_errored'; project: string; pipeline: string }
  | { type: 'embed_completed'; project: string }
  | { type: string; project?: string; pipeline?: string };

/**
 * Return the throttle-map key for a progress-eligible event, or `null` for
 * events that bypass the throttle floor. Mirrors the keying scheme used by
 * `teardownProjectBookkeeping` (`${project}::${pipeline}` and
 * `${project}::embed`).
 */
export function throttleKeyFor(event: ThrottleAwareEvent): string | null {
  if (event.type === 'indexing_progress') {
    return `${event.project}::${event.pipeline}`;
  }
  if (event.type === 'embed_progress') {
    return `${event.project}::embed`;
  }
  return null;
}

/**
 * Drop the throttle-map entry corresponding to a terminal pipeline event.
 * Idempotent — missing keys are no-ops. Use this from `broadcastEvent` so
 * completed pipelines do not pin throttle keys inside an active project
 * (the project-level teardown already prunes by `${root}::` prefix; this
 * handles the in-flight case).
 */
export function clearKeyForTerminalEvent(
  map: Map<string, number>,
  event: ThrottleAwareEvent,
): void {
  if (event.type === 'reindex_completed' || event.type === 'reindex_errored') {
    if (typeof event.project === 'string' && typeof event.pipeline === 'string') {
      map.delete(`${event.project}::${event.pipeline}`);
    }
    return;
  }
  if (event.type === 'embed_completed') {
    if (typeof event.project === 'string') {
      map.delete(`${event.project}::embed`);
    }
    return;
  }
}

/**
 * Passive sweep: drop entries with `value < now - maxAgeMs`. Cheap — runs
 * inline at most once per event, only when the map's `size` already exceeds
 * the soft cap. No timer, no async work. Returns the number of entries
 * removed (useful for tests; cli.ts ignores it).
 */
export function pruneStaleEntries(map: Map<string, number>, now: number, maxAgeMs: number): number {
  const cutoff = now - maxAgeMs;
  let removed = 0;
  for (const [k, v] of map) {
    if (v < cutoff) {
      map.delete(k);
      removed++;
    }
  }
  return removed;
}

/**
 * Throttle-eligible event types. cli.ts uses this set to decide whether the
 * 200 ms floor applies; exported so tests don't duplicate the list.
 */
export const THROTTLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'indexing_progress',
  'embed_progress',
]);

/**
 * Decide whether a throttle-eligible event should be emitted right now and
 * update bookkeeping. Encapsulates the "200 ms floor + record-last" logic
 * that previously lived inline in `broadcastEvent`.
 *
 * Contract:
 *   - For non-throttled events: returns `true`, does not touch the map.
 *   - For throttled events fired faster than `throttleMs` since the last
 *     emit on the same key: returns `false`, does not update the map.
 *   - For throttled events fired after the floor: returns `true` and stamps
 *     the current `now` into the map for the next decision.
 */
export function shouldEmitThrottledEvent(
  map: Map<string, number>,
  event: ThrottleAwareEvent,
  now: number,
  throttleMs: number,
): boolean {
  const key = throttleKeyFor(event);
  if (key === null) return true;
  const last = map.get(key) ?? 0;
  if (now - last < throttleMs) return false;
  map.set(key, now);
  return true;
}

/**
 * Convenience wrapper that runs the passive sweep when the map exceeds
 * `softCap`. Safe to call on every event — the sweep itself only fires when
 * the cap is breached. Returns the entries removed (0 when no sweep ran).
 */
export function maybePruneOnHighWatermark(
  map: Map<string, number>,
  now: number,
  softCap: number = DEFAULT_PROGRESS_MAP_SOFT_CAP,
  maxAgeMs: number = DEFAULT_PROGRESS_STALE_MS,
): number {
  if (map.size <= softCap) return 0;
  return pruneStaleEntries(map, now, maxAgeMs);
}
