/**
 * Hot-churn runtime-state files (TRA-2021).
 *
 * Agent-runtime state files are rewritten every few seconds but carry no
 * indexable content: `state/gateway.heartbeat` (~2 rewrites/min, content
 * hash unchanged — every pass reports `skippedHash=true, indexed=0`) and
 * `cron/ticker_*` + `cron/.tick.lock`. On one project these burned ~250 s
 * of indexer-elapsed per hour and their lock-queue stalls (up to 47 s)
 * starved the daemon event loop until /health timed out and 31 sessions
 * flipped to local-fallback on a live daemon.
 *
 * They are engine scratch, never source — the same argument TRA-1943
 * applies to SQLite sidecars — so every indexing entry point drops them
 * before any stat/read/lock, mirroring `isSqliteSidecarPath`:
 * watcher (before debounce), `filterIndexablePaths` (before the pipeline
 * lock), `collectFiles` (full walk), `FileExtractor` (defence in depth),
 * and the HTTP reindex handler (before `withLock`).
 */

/**
 * Native-watcher ignore globs (relative to the watched root) for the same
 * set. Parcel drops these before they cross the native→JS boundary; the
 * JS-level `isHotChurnPath` filter below stays the authoritative guard
 * (native ignore lists snapshot at subscribe-time).
 */
export const HOT_CHURN_NATIVE_IGNORE_GLOBS = [
  '**/gateway.heartbeat',
  '**/.tick.lock',
  '**/cron/ticker_*',
] as const;

/** Basenames that are always runtime churn, wherever they live. */
const HOT_CHURN_BASENAMES = new Set(['gateway.heartbeat', '.tick.lock']);

/**
 * Whether a project-relative (or absolute) path is a hot-churn
 * runtime-state file. Matched on the basename / a whole `cron` path
 * segment, so a directory that merely contains these strings never nukes
 * the real source files inside it.
 */
export function isHotChurnPath(p: string): boolean {
  const segments = p.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return false;
  const base = segments[segments.length - 1].toLowerCase();
  if (HOT_CHURN_BASENAMES.has(base)) return true;
  // `cron/ticker_*`: agent tick markers — the parent segment must be
  // exactly `cron`, not a substring like `cronjobs`.
  if (base.startsWith('ticker_')) {
    const parents = segments.slice(0, -1).map((s) => s.toLowerCase());
    if (parents.includes('cron')) return true;
  }
  return false;
}
