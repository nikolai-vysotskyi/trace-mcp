/**
 * Startup eager-load selection for `serve-http`.
 *
 * The daemon used to call `addProject()` for every registered project at
 * boot. Each loaded project costs ~9 MB of live JS heap plus its SQLite page
 * cache / mmap window *before it holds any code* (TRA-278 measurement: 40
 * empty two-file projects => 423 MB live heap after a forced GC), so a
 * developer machine with ~100 registered repos paid multi-GB RSS at every
 * daemon start for projects nobody was using.
 *
 * Projects left out here are not lost: a registered root that is absent from
 * the ProjectManager is treated exactly like an idle-unloaded one — the first
 * request lazily re-adds it and gets 503 + Retry-After while it warms (see
 * `project_idle_unload_minutes` and cli.ts serve-http Phase 5.1).
 */
import type { RegistryEntry } from '../registry.js';

/** Recency key: last successful index, falling back to registration time. */
function recencyOf(entry: RegistryEntry): number {
  const raw = entry.lastIndexed ?? entry.addedAt;
  const t = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Split registered projects into the ones to load at boot and the ones to
 * leave for lazy load. `cap <= 0` disables the cap (loads everything, the
 * pre-TRA-278 behaviour).
 *
 * TRA-1863: a multi-root parent (e.g. `thewed`) intentionally watches its
 * declared children's subtrees too — `registeredDescendantRoots()` excludes
 * declared children from the ancestor's ignore list, so every edit under a
 * child double-indexes while the parent is resident. When recency ranking
 * puts the parent inside the cap but a registered child outside it, the
 * child has no watcher of its own, its DB rots, and query routing
 * (`resolveDeepestKnownRoot` prefers the deepest root) keeps serving that
 * stale child DB. So an eager multi-root parent pulls its still-deferred
 * REGISTERED declared children into the eager set with it — one logical
 * unit stays co-resident. The cap may be exceeded by the size of the family;
 * it remains a soft startup budget (the idle-unload sweep still enforces
 * `daemon_eager_load_projects` as the steady-state ceiling afterwards).
 */
export function selectEagerLoadRoots(
  entries: RegistryEntry[],
  cap: number,
): { eager: RegistryEntry[]; deferred: RegistryEntry[] } {
  if (cap <= 0 || entries.length <= cap) return { eager: entries, deferred: [] };
  const ranked = [...entries].sort((a, b) => recencyOf(b) - recencyOf(a));
  const eager = ranked.slice(0, cap);
  const deferred = ranked.slice(cap);
  const eagerRoots = new Set(eager.map((e) => e.root));
  const deferredByRoot = new Map(deferred.map((e) => [e.root, e]));
  for (const parent of eager) {
    if (parent.type !== 'multi-root') continue;
    for (const childRoot of parent.children ?? []) {
      const child = deferredByRoot.get(childRoot);
      if (!child) continue;
      deferredByRoot.delete(childRoot);
      eagerRoots.add(childRoot);
      eager.push(child);
    }
  }
  return { eager, deferred: deferred.filter((e) => !eagerRoots.has(e.root)) };
}
