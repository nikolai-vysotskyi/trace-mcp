/**
 * Hot-churn runtime-state files (TRA-2021, extended by TRA-2031).
 *
 * Agent-runtime state files are rewritten every few seconds but carry no
 * indexable content: `state/gateway.heartbeat` (~2 rewrites/min, content
 * hash unchanged — every pass reports `skippedHash=true, indexed=0`) and
 * `cron/ticker_*` + `cron/.tick.lock`. On one project these burned ~250 s
 * of indexer-elapsed per hour and their lock-queue stalls (up to 47 s)
 * starved the daemon event loop until /health timed out and 31 sessions
 * flipped to local-fallback on a live daemon.
 *
 * TRA-2031: the same runtime also writes these atomically (tmp + rename —
 * `cron/.hb_*.tmp`, `state/.gateway_*.tmp`), and the watcher catches the
 * tmp between create and rename (10× `Cannot read file ENOENT` on a live
 * daemon). The tmp siblings are the same engine scratch, never source, so
 * they drop at the same entry points.
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
 * set. Best-effort only: on some platforms/backends parcel does not apply
 * glob ignores to live events, so the JS-level `isHotChurnPath` filter
 * below stays the authoritative guard (this list also snapshots at
 * subscribe-time). Globs mirror the predicate's narrowed shapes so the
 * two lists cannot silently diverge in scope.
 */
export const HOT_CHURN_NATIVE_IGNORE_GLOBS = [
  '**/gateway.heartbeat',
  '**/.tick.lock',
  '**/cron/ticker_*',
  // TRA-2031: atomic-write tmp siblings (tmp + rename) of the same state.
  '**/cron/.hb_*.tmp',
  '**/cron/.gateway_*.tmp',
  '**/state/.hb_*.tmp',
  '**/state/.gateway_*.tmp',
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
  // TRA-2031: atomic-write tmp siblings (`cron/.hb_*.tmp`,
  // `state/.gateway_*.tmp`) — hermes writes heartbeat/ticker state via
  // tmp + rename and the watcher catches the tmp between create and
  // rename (`Cannot read file ENOENT`). Narrowed to the observed
  // `.hb_` / `.gateway_` basename prefixes under a whole `cron`/`state`
  // segment: a bare `*.tmp` — or any dot-tmp — is a real user source far
  // too often (`src/state/.env.tmp`, `app/state/.session.tmp`), and the
  // whole-segment rule (as in TRA-2021) keeps `cronjobs/`-style
  // substring dirs from matching.
  if (base.startsWith('.') && base.endsWith('.tmp')) {
    if (!base.startsWith('.hb_') && !base.startsWith('.gateway_')) return false;
    const parents = segments.slice(0, -1).map((s) => s.toLowerCase());
    if (parents.includes('cron') || parents.includes('state')) return true;
  }
  return false;
}
