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
 */
export function selectEagerLoadRoots(
  entries: RegistryEntry[],
  cap: number,
): { eager: RegistryEntry[]; deferred: RegistryEntry[] } {
  if (cap <= 0 || entries.length <= cap) return { eager: entries, deferred: [] };
  const ranked = [...entries].sort((a, b) => recencyOf(b) - recencyOf(a));
  return { eager: ranked.slice(0, cap), deferred: ranked.slice(cap) };
}
