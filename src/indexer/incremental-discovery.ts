/**
 * TRA-1576 — incremental discovery fast paths (F1 follow-up to TRA-1536).
 *
 * TRA-1536 eliminated the hash-gate scan (1903 extract dispatches → 1 for a
 * 1-file change, 2747 ms → 2 ms cumulative) but left the residual
 * `collectFiles()` walk (~119 ms: double fast-glob for root + workspaces,
 * plus the picomatch deep-fallback) on every incremental `indexAll()`.
 * This module answers "which files may have changed" without walking:
 *
 *   1. **watcher since-query (primary)** — `@parcel/watcher`'s
 *      `getEventsSince(dir, snapshotFile)` returns create/update/delete
 *      events since a previously written snapshot, including changes made
 *      while the process was not running (daemon restarts, CLI runs). On
 *      macOS this reads the FSEvents log (no tree walk); on Linux it goes
 *      through the inotify backend or falls back to brute-force. Any failure
 *      — missing snapshot, missing native module, backend error, log
 *      truncation — returns null and the caller falls back to the walk.
 *   2. **git-status fast path** — when the repo is clean except N files,
 *      `git status --porcelain=v1 -z` lists exactly those files with one
 *      git spawn (~10-30 ms), replacing the double fast-glob + picomatch
 *      fallback (~12% of the collect share per the TRA-1536 measurement).
 *      Capped at `GIT_FAST_PATH_MAX_FILES`: beyond that the per-file
 *      extract cost approaches a full walk anyway, so walk instead.
 *   3. **full walk (fallback + periodic verification)** — `collectFiles()`
 *      stays the source of truth. Fast paths never reconcile scope (they
 *      know nothing about the rest of the tree), so every Nth incremental
 *      run — or when the last full walk is older than
 *      `FULL_WALK_MAX_AGE_MS` — forces a full walk (`shouldForceFullWalk`).
 *
 * Correctness contract (enforced by `tests/indexer/incremental-discovery.test.ts`):
 *
 *   - A fast path may OVER-report (ignored files, out-of-include files —
 *     the pipeline's `filterIndexablePaths` + include gate drops those) but
 *     must never UNDER-report relative to what it observed: every path the
 *     source names survives our own gates iff it matches the include globs.
 *   - Staleness is bounded, not eliminated: a fast-path miss (dropped
 *     FSEvents, same-floor rewrite the prefilter also can't see) heals at
 *     the next periodic full walk. The prefilter + content-hash gate below
 *     still re-verify every candidate, so a stale fast path costs redundant
 *     work, never a corrupt index — except the exact mtime+size-match case
 *     documented in `change-prefilter.ts`, which no stat-based scheme sees.
 *   - After a reported FSEvents drop (`onRescan` in project-manager.ts) the
 *     caller MUST pass `discovery: 'full-walk'`: the since-query shares the
 *     same FSEvents backend that just reported loss.
 *
 * Platform notes (acceptance: Linux + macOS):
 *
 *   - macOS (FSEvents): since-query is a log read, no walk. Snapshot is a
 *     small opaque file; `writeSnapshot` after every successful run keeps it
 *     fresh. First-load amfid race (watcher.ts) applies to the dynamic
 *     import here too — an import failure just means "no fast path".
 *   - Linux (inotify): historical query needs the snapshot written by an
 *     earlier run on the same machine; inotify watch-descriptor limits do
 *     NOT apply to `getEventsSince` (it installs no watches), but where the
 *     backend cannot answer it throws and we fall back to the walk. The git
 *     fast path has no inotify interaction at all and is the main Linux win
 *     for repos (non-git trees still get the walk).
 *   - Ignores are passed to the native layer (`ignore` opt) with the same
 *     list `watcher.subscribe` uses, so runtime churn under excluded dirs
 *     never crosses the native→JS boundary; the JS-side include/exclude
 *     gates run again anyway (cheap, and the native list can go stale).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { logger } from '../logger.js';
import { safeGitEnv } from '../utils/git-env.js';

export type DiscoverySource = 'watcher-since' | 'git-status' | 'full-walk';

export interface DiscoveryResult {
  source: DiscoverySource;
  /** Repo-relative posix paths that may have changed (creates + updates). */
  changed: string[];
  /** Repo-relative posix paths deleted since the last run. */
  deleted: string[];
}

/** Above this many git-touched files the walk is cheaper/safer — walk. */
export const GIT_FAST_PATH_MAX_FILES = 500;
/**
 * Bound for one native watcher round-trip (`getEventsSince`, `writeSnapshot`)
 * (TRA-1843).
 *
 * Field case: initial `indexAll` runs sat inside `tryIncrementalDiscovery`'s
 * since-query while the native watcher layer was wedged — 0% CPU, zero
 * pipeline lines, both `indexAllLimit` slots leaked forever, every later
 * `indexAll` queued behind them. A since-query that does not answer in this
 * long is not slow (healthy ones answer in ms), so fall back to the full walk
 * instead of holding the run — and a snapshot write that does not answer is
 * post-run bookkeeping, so skip it instead of holding the run's settlement.
 */
export const WATCHER_NATIVE_TIMEOUT_MS = 30_000;
let watcherNativeTimeoutMs = WATCHER_NATIVE_TIMEOUT_MS;
/** Test seam — the timeout above is far too long for a unit test to wait out. */
export function setWatcherNativeTimeoutForTests(ms: number): void {
  watcherNativeTimeoutMs = ms;
}
export function resetWatcherNativeTimeoutForTests(): void {
  watcherNativeTimeoutMs = WATCHER_NATIVE_TIMEOUT_MS;
}

/** Race `promise` against the native-watcher bound; reject with `message` on timeout. */
function withNativeTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), watcherNativeTimeoutMs);
  });
  // The timeout always fires, so the clear below always runs — no handle leak
  // even when the native promise never settles.
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
/** Force a verifying full walk every Nth incremental run at the latest. */
export const FULL_WALK_EVERY_N_RUNS = 10;
/** …or when the last full walk is older than this (stale-scope bound). */
export const FULL_WALK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** repo_metadata keys for the periodic-verification counters. */
export const META_RUNS_SINCE_FULL = 'discovery_runs_since_full';
export const META_LAST_FULL_MS = 'discovery_last_full_ms';

/**
 * Snapshot file co-located with the per-project index DB
 * (`~/.trace/index/<name>-<hash>.db` → `….db.watcher-snapshot`): one file
 * per project, survives restarts, never inside the indexed tree (so the
 * snapshot write itself can never surface as a change event).
 */
export function snapshotPathForDb(dbPath: string): string {
  return `${dbPath}.watcher-snapshot`;
}

/** Absolute → repo-relative posix; null when outside the root. */
export function toRelPosix(rootPath: string, absPath: string): string | null {
  const rel = path.isAbsolute(absPath) ? path.relative(rootPath, absPath) : absPath;
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export interface SinceEvents {
  changedAbs: string[];
  deletedAbs: string[];
}

export type QueryWatcherSinceFn = (
  rootPath: string,
  snapshotPath: string,
  ignore?: string[],
) => Promise<SinceEvents | null>;

export type QueryGitStatusFn = (
  rootPath: string,
) => { changed: string[]; deleted: string[] } | null;

/**
 * Historical change query via `@parcel/watcher`. Returns null (→ caller
 * falls back) when the snapshot does not exist yet, the native module
 * cannot load (amfid race, missing prebuild, tests), or the backend throws
 * (log truncation, unsupported platform path).
 */
export const queryWatcherSince: QueryWatcherSinceFn = async (rootPath, snapshotPath, ignore) => {
  if (!fs.existsSync(snapshotPath)) return null;
  let watcher: typeof import('@parcel/watcher');
  try {
    watcher = (await import('@parcel/watcher')) as typeof import('@parcel/watcher');
  } catch (err) {
    logger.debug({ err }, 'watcher since-query: native module unavailable — full walk');
    return null;
  }
  let events: Array<{ path: string; type: string }>;
  try {
    events = (await withNativeTimeout(
      watcher.getEventsSince(rootPath, snapshotPath, ignore ? { ignore } : {}),
      `watcher getEventsSince timed out after ${watcherNativeTimeoutMs}ms for ${rootPath} (TRA-1843)`,
    )) as Array<{
      path: string;
      type: string;
    }>;
  } catch (err) {
    // FSEvents log truncation ("events were dropped" family), inotify
    // backend refusal, brute-force fallback failure — all mean the answer
    // may be incomplete, and an incomplete answer is worse than a slow one.
    // A timeout lands here too: a wedged native layer must fall back to the
    // walk, never hold the indexAll run (TRA-1843).
    logger.debug({ err, rootPath }, 'watcher since-query failed — full walk');
    return null;
  }
  const changedAbs: string[] = [];
  const deletedAbs: string[] = [];
  for (const e of events) {
    if (e.type === 'delete') deletedAbs.push(e.path);
    else if (e.type === 'create' || e.type === 'update') changedAbs.push(e.path);
  }
  return { changedAbs, deletedAbs };
};

/**
 * Persist the current watcher timestamp. Best-effort: returns false (never
 * throws) when the native module is unavailable. Call after every
 * successful run — full or fast — so the next since-query window starts now.
 */
export async function writeWatcherSnapshot(
  rootPath: string,
  snapshotPath: string,
  ignore?: string[],
): Promise<boolean> {
  let watcher: typeof import('@parcel/watcher');
  try {
    watcher = (await import('@parcel/watcher')) as typeof import('@parcel/watcher');
  } catch {
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    await withNativeTimeout(
      watcher.writeSnapshot(rootPath, snapshotPath, ignore ? { ignore } : {}),
      `watcher writeSnapshot timed out after ${watcherNativeTimeoutMs}ms for ${rootPath} (TRA-1843)`,
    );
    return true;
  } catch (err) {
    logger.debug({ err, rootPath }, 'watcher writeSnapshot failed (non-fatal)');
    return false;
  }
}

export type ExecGitStatusFn = (
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => string;

/**
 * Parse `git status --porcelain=v1 -z` output. NUL-separated entries of
 * shape `XY<space>path`; rename/copy entries carry the orig path as a
 * second, bare NUL-separated record (`R  new\0old\0` — no ` -> ` arrow in
 * -z output). Pure — unit tested with canned outputs including
 * spaces-in-names (only safe because of `-z`).
 */
export function parseGitStatusPorcelainZ(output: string): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  if (!output) return { changed, deleted };
  const entries = output.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    // Format: XY<space>path   (XY = staged/worktree status, 2 cols + space).
    // The space check rejects bare rename-orig records that lost their
    // parent entry (desync) instead of mangling them into paths.
    if (entry.length < 4 || entry[2] !== ' ') continue;
    const x = entry[0];
    const y = entry[1];
    const filePath = entry.slice(3);
    // Rename/copy: the new path exists on disk (changed), the orig path is
    // gone (deleted). With -z the orig path follows as a bare record;
    // without -z it is glued with " -> " (defensive fallback only).
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
      const arrow = filePath.indexOf(' -> ');
      if (arrow >= 0) {
        changed.push(unquotePorcelain(filePath.slice(arrow + 4)));
        deleted.push(unquotePorcelain(filePath.slice(0, arrow)));
        continue;
      }
      changed.push(unquotePorcelain(filePath));
      const from = entries[i + 1];
      if (from) {
        i++;
        deleted.push(unquotePorcelain(from));
      }
      continue;
    }
    // Surrounding quotes appear only without -z; strip defensively.
    const p = unquotePorcelain(filePath);
    if (x === 'D' || y === 'D') deleted.push(p);
    else changed.push(p);
  }
  return { changed, deleted };
}

/** Strip the C-style quoting git uses without -z (no-op on -z output). */
function unquotePorcelain(p: string): string {
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) return p.slice(1, -1);
  return p;
}

const defaultExecGitStatus: ExecGitStatusFn = (args, opts) =>
  execFileSync('git', args, { cwd: opts.cwd, env: opts.env, encoding: 'utf-8' }) as string;

/**
 * Git-status discovery fast path. Returns null (→ full walk) when: not a
 * git repo / git missing / any error; or when the touched set exceeds
 * `GIT_FAST_PATH_MAX_FILES` (bulk checkout/branch-switch — the walk +
 * prefilter handles those better and re-reconciles scope as a bonus).
 * Paths are repo-relative posix as git prints them (relative to `rootPath`
 * when it is the work-tree root; else filtered by the caller).
 */
export function queryGitStatus(
  rootPath: string,
  maxFiles = GIT_FAST_PATH_MAX_FILES,
  execFn: ExecGitStatusFn = defaultExecGitStatus,
): { changed: string[]; deleted: string[] } | null {
  let output: string;
  try {
    output = execFn(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: rootPath,
      env: safeGitEnv(),
    });
  } catch {
    return null;
  }
  const { changed, deleted } = parseGitStatusPorcelainZ(output);
  if (changed.length + deleted.length > maxFiles) {
    logger.debug(
      { touched: changed.length + deleted.length, maxFiles },
      'git-status fast path over cap — full walk',
    );
    return null;
  }
  return { changed, deleted };
}

/**
 * Keep only paths matching the pipeline's include globs (collectFiles
 * semantics: fast-glob only ever returns include matches). Excludes /
 * gitignore / traceignore / descendant-ownership stay with the pipeline's
 * `filterIndexablePaths` — this gate must be a superset-safe pre-filter,
 * never a second opinion on excludes.
 */
export function intersectWithInclude(relPaths: string[], include: string[]): string[] {
  if (relPaths.length === 0) return [];
  const isIncluded = picomatch(include, { dot: true });
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of relPaths) {
    if (!isIncluded(p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Periodic-verification policy: fast paths never reconcile scope, so force
 * a full walk every Nth incremental run or when the last full walk is older
 * than the age bound — whichever comes first. Pure; counters live in
 * repo_metadata (`META_RUNS_SINCE_FULL` / `META_LAST_FULL_MS`).
 */
export function shouldForceFullWalk(args: {
  runsSinceFull: number;
  lastFullMs: number | null;
  nowMs?: number;
  everyNRuns?: number;
  maxAgeMs?: number;
}): boolean {
  const {
    runsSinceFull,
    lastFullMs,
    nowMs = Date.now(),
    everyNRuns = FULL_WALK_EVERY_N_RUNS,
    maxAgeMs = FULL_WALK_MAX_AGE_MS,
  } = args;
  if (runsSinceFull >= everyNRuns) return true;
  if (lastFullMs == null) return true;
  return nowMs - lastFullMs >= maxAgeMs;
}

export interface DiscoverIncrementalArgs {
  rootPath: string;
  snapshotPath: string | null;
  include: string[];
  /** Native-layer ignore list (same as watcher.subscribe) — optional. */
  watcherIgnore?: string[];
  queryWatcher?: QueryWatcherSinceFn;
  queryGit?: QueryGitStatusFn;
}

/**
 * Orchestrator: watcher-since → git-status → full-walk. Returns include-
 * gated relative posix lists; the pipeline still runs its own
 * `filterIndexablePaths` (excludes/gitignore/descendants) over them.
 * NEVER returns a partial answer: any doubt → `{ source: 'full-walk' }`
 * with empty lists and the caller walks.
 */
export async function discoverIncrementalFiles(
  args: DiscoverIncrementalArgs,
): Promise<DiscoveryResult> {
  const {
    rootPath,
    snapshotPath,
    include,
    watcherIgnore,
    queryWatcher = queryWatcherSince,
    queryGit = (root: string) => queryGitStatus(root),
  } = args;

  if (snapshotPath) {
    let since: SinceEvents | null = null;
    try {
      since = await queryWatcher(rootPath, snapshotPath, watcherIgnore);
    } catch {
      since = null;
    }
    if (since) {
      const changed: string[] = [];
      for (const abs of since.changedAbs) {
        const rel = toRelPosix(rootPath, abs);
        if (rel) changed.push(rel);
      }
      const deleted: string[] = [];
      for (const abs of since.deletedAbs) {
        const rel = toRelPosix(rootPath, abs);
        if (rel) deleted.push(rel);
      }
      return {
        source: 'watcher-since',
        changed: intersectWithInclude(changed, include),
        // Deletes never matched include globs on disk (the file is gone) —
        // pass them through; deleteFiles() no-ops unknown rows.
        deleted,
      };
    }
  }

  let git: { changed: string[]; deleted: string[] } | null = null;
  try {
    git = queryGit(rootPath);
  } catch {
    git = null;
  }
  if (git) {
    return {
      source: 'git-status',
      changed: intersectWithInclude(git.changed, include),
      deleted: git.deleted,
    };
  }

  return { source: 'full-walk', changed: [], deleted: [] };
}
