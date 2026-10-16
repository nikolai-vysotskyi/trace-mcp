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
 * TRA-2057: same race, new prefix — `cache/.reasoning_caps_*.tmp`
 * (atomic rewrite of `cache/reasoning_caps.json`, 4× ENOENT already on a
 * daemon with the TRA-2031 fix; the TRA-2031 matcher never covered the
 * `.reasoning_caps_` prefix or the `cache/` segment). Same narrowed
 * treatment: exact dot-tmp prefix + a whole `cache` path segment.
 *
 * TRA-2326: atomic rewrite of ML checkpoint artifacts (e.g. `resume_mlx.npz.tmp`
 * or `enc.onnx.data.tmp` renamed to `resume_mlx.npz` / `enc.onnx.data` in
 * `.../artifacts/...` or `.../checkpoints/...`). The watcher catches the tmp
 * between create and atomic rename (199+ `Cannot read file ENOENT` on a live
 * daemon). Narrowed to `.npz.tmp` or `.onnx.data.tmp` (or ML checkpoint tmp)
 * under whole `artifacts` or `checkpoints` directory segments.
 * TRA-2479: `.pt.tmp` and `.pth.tmp` checkpoint swaps also occur under
 * `runs`, `train`, and `ocr_train`; drop them before the read attempt.
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
 * subscribe-time). Claude Code's pid/hex suffix is omitted here: native
 * globs cannot express its narrow shape without also hiding real sources.
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
  // TRA-2057: atomic rewrite of `cache/reasoning_caps.json`.
  '**/cache/.reasoning_caps_*.tmp',
  // TRA-2326: atomic rewrite of ML checkpoint artifacts.
  '**/artifacts/**/*.npz.tmp',
  '**/artifacts/**/*.onnx.data.tmp',
  '**/checkpoints/**/*.npz.tmp',
  '**/checkpoints/**/*.onnx.data.tmp',
  // TRA-2479: temporary PyTorch weights in training runs and checkpoints.
  '**/runs/**/*.pt.tmp',
  '**/runs/**/*.pth.tmp',
  '**/artifacts/**/*.pt.tmp',
  '**/artifacts/**/*.pth.tmp',
  '**/checkpoints/**/*.pt.tmp',
  '**/checkpoints/**/*.pth.tmp',
  '**/train/**/*.pt.tmp',
  '**/train/**/*.pth.tmp',
  '**/ocr_train/**/*.pt.tmp',
  '**/ocr_train/**/*.pth.tmp',
  // TRA-2456: training logs churn continuously on every batch/epoch.
  '**/runs/**/*.log',
  '**/train/**/*.log',
  '**/ocr_train/**/*.log',
] as const;

/** Basenames that are always runtime churn, wherever they live. */
const HOT_CHURN_BASENAMES = new Set(['gateway.heartbeat', '.tick.lock']);
const ML_WEIGHT_DIRECTORIES = new Set(['runs', 'artifacts', 'checkpoints', 'train', 'ocr_train']);

/** Target of a Claude Code atomic-write sibling, or undefined for other paths. */
export function atomicWriteTargetPath(p: string): string | undefined {
  const base = p.split(/[\\/]/).at(-1) ?? '';
  const match = /^(.+\.[^.\\/]+)\.tmp\.\d+\.[0-9a-f]{8,}$/i.exec(base);
  return match ? p.slice(0, -base.length) + match[1] : undefined;
}

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
  // Claude Code writes source edits through a uniquely named sibling and
  // renames it over the target. Drop the sibling before watcher debounce.
  if (atomicWriteTargetPath(p) !== undefined) return true;
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
  // TRA-2057: same race for `cache/reasoning_caps.json`, written via
  // `cache/.reasoning_caps_<rand>.tmp` + rename. Narrowed the same way:
  // the exact `.reasoning_caps_` prefix under a whole `cache` segment,
  // so `src/cache/.session.tmp` or `caches/`-style dirs never match.
  if (base.startsWith('.') && base.endsWith('.tmp')) {
    const parents = segments.slice(0, -1).map((s) => s.toLowerCase());
    if (
      (base.startsWith('.hb_') || base.startsWith('.gateway_')) &&
      (parents.includes('cron') || parents.includes('state'))
    )
      return true;
    if (base.startsWith('.reasoning_caps_') && parents.includes('cache')) return true;
  }

  // TRA-2326: atomic rewrites of ML checkpoint artifacts (e.g. `resume_mlx.npz.tmp`
  // or `enc.onnx.data.tmp`) under whole `artifacts` or `checkpoints` segments.
  // A bare `*.tmp` is preserved for general source/text files; here we match
  // temporary files of ML binary artifacts (`.npz.tmp`, `.onnx.data.tmp`)
  // strictly inside training/checkpoint directories.
  if (base.endsWith('.npz.tmp') || base.endsWith('.onnx.data.tmp')) {
    const parents = segments.slice(0, -1).map((s) => s.toLowerCase());
    if (parents.includes('artifacts') || parents.includes('checkpoints')) return true;
  }

  // Training checkpoints are often written to a temporary sibling before
  // rename. Skip only known training directories, including the observed
  // `ocr_train` layout, so arbitrary user `.tmp` files remain indexable.
  if (base.endsWith('.pt.tmp') || base.endsWith('.pth.tmp')) {
    const parents = segments.slice(0, -1).map((s) => s.toLowerCase());
    if (parents.some((s) => ML_WEIGHT_DIRECTORIES.has(s))) return true;
  }

  // TRA-2456: append-only training logs churn continuously during model training runs.
  if (base.endsWith('.log')) {
    const parents = segments.slice(0, -1).map((s) => s.toLowerCase());
    if (parents.some((s) => ML_WEIGHT_DIRECTORIES.has(s))) return true;
  }

  return false;
}
