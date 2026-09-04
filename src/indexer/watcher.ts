import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type * as parcelWatcher from '@parcel/watcher';
import picomatch from 'picomatch';
import type { TraceMcpConfig } from '../config.js';
import { logger } from '../logger.js';
import { GitignoreMatcher } from '../utils/gitignore.js';
import { TraceignoreMatcher } from '../utils/traceignore.js';

type ParcelWatcherModule = typeof parcelWatcher;

/** Debounce window in ms — coalesces rapid saves from editors. */
const DEFAULT_DEBOUNCE_MS = 300;

/**
 * Retry delays (ms) for loading @parcel/watcher on macOS. The prebuilt
 * ad-hoc-signed `.node` bundle can race with amfid/syspolicyd on first load
 * (symptom: "library load disallowed by system policy"). The retry window
 * covers the observed race; subsequent loads succeed because the signature
 * has since been validated by the OS.
 */
const MAC_LOAD_RETRY_DELAYS_MS = [300, 900, 2000];

let cachedWatcher: ParcelWatcherModule | null = null;

/**
 * The OS event queue overflowed and events were discarded before reaching us
 * (macOS FSEvents: "Events were dropped by the FSEvents client. File system
 * must be re-scanned."; the inotify/Windows backends word it the same way).
 * Happens on bulk changes — branch checkout, `pnpm install`, wake from sleep.
 * Every change in the lost window is invisible to the watcher forever, so the
 * index silently diverges from disk unless we re-walk the root.
 */
function isEventsDroppedError(err: unknown): boolean {
  const msg = (err as { message?: string })?.message;
  return typeof msg === 'string' && msg.toLowerCase().includes('events were dropped');
}

function isMacSystemPolicyError(e: unknown): boolean {
  if (process.platform !== 'darwin') return false;
  const err = e as NodeJS.ErrnoException & { message?: string };
  if (err?.code !== 'ERR_DLOPEN_FAILED') return false;
  return (
    typeof err.message === 'string' &&
    err.message.includes('library load disallowed by system policy')
  );
}

function extractDlopenPath(e: unknown): string | null {
  const msg = (e as { message?: string })?.message;
  if (typeof msg !== 'string') return null;
  const match = msg.match(/dlopen\(([^,)]+)/);
  return match ? match[1] : null;
}

/** Ask macOS to verify the signature — forces amfid to complete first-load assessment. */
function primeAmfid(file: string): void {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', file], { stdio: 'ignore', timeout: 5000 });
  } catch {
    /* best effort — even a rejection means amfid has now assessed the file */
  }
}

async function loadParcelWatcher(): Promise<ParcelWatcherModule> {
  if (cachedWatcher) return cachedWatcher;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAC_LOAD_RETRY_DELAYS_MS.length; attempt++) {
    try {
      cachedWatcher = (await import('@parcel/watcher')) as ParcelWatcherModule;
      return cachedWatcher;
    } catch (e) {
      lastErr = e;
      if (!isMacSystemPolicyError(e)) throw e;
      const file = extractDlopenPath(e);
      logger.warn({ file, attempt }, 'macOS rejected native watcher load — retrying');
      if (file) primeAmfid(file);
      if (attempt < MAC_LOAD_RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, MAC_LOAD_RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  throw lastErr;
}

interface StartOpts {
  /**
   * POSIX globs (relative to rootPath) for every registered project root
   * that is a strict descendant of this watcher's rootPath — see
   * `descendantExcludeGlobs()` in registry.ts. An umbrella root's watcher
   * must not fire (or reindex) for files a more-specific registered
   * project already owns; without this an ancestor + descendant pair
   * double-watches and double-indexes every file under the descendant
   * (#209). Empty/undefined when this project has no registered
   * descendants.
   */
  descendantExcludeGlobs?: string[];
  /**
   * Repair pass for dropped fs events (see `isEventsDroppedError`). Must
   * re-walk the project root and reconcile against the index — i.e.
   * `pipeline.indexAll()`, which is hash-gated (unchanged files are skipped,
   * not re-parsed) and drops rows for files that vanished. Optional: a caller
   * that doesn't own a pipeline just keeps the old log-and-ignore behaviour.
   */
  onRescan?: () => Promise<void>;
}

export class FileWatcher {
  private subscription: parcelWatcher.AsyncSubscription | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPaths: Set<string> = new Set();
  /** Args from the most recent start() call, kept so restartWithExcludes()
   *  can re-subscribe without the caller re-threading every closure. */
  private lastStartArgs: {
    rootPath: string;
    config: TraceMcpConfig;
    onChanges: (paths: string[]) => Promise<void>;
    debounceMs: number;
    onDeletes?: (paths: string[]) => Promise<void>;
    onRescan?: () => Promise<void>;
  } | null = null;
  /** Guards against a rescan stampede: FSEvents drops arrive in bursts, and a
   *  reconcile pass walks the whole root. At most one runs at a time; drops
   *  seen while one is in flight collapse into a single follow-up pass (the
   *  in-flight walk may have already passed the files they touched). */
  private rescanInFlight = false;
  private rescanPending = false;
  /**
   * Serializes start()/stop()/restartWithExcludes() on this instance. Without
   * this, two overlapping calls (e.g. ProjectManager.restartManagedAncestorWatchers
   * firing for two sibling descendants registered under the same ancestor at
   * nearly the same time) both read `this.subscription` before either has
   * assigned its own, so the second `watcher.subscribe()` silently overwrites
   * the first's subscription without ever unsubscribing it — a leaked live
   * fs-event handle whose stale closure keeps double-indexing forever.
   * Every call chains off this promise so it always observes the fully
   * settled state left by the previous call.
   */
  private opQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly _setTimeout: typeof setTimeout = setTimeout,
    private readonly _clearTimeout: typeof clearTimeout = clearTimeout,
  ) {}

  async start(
    rootPath: string,
    config: TraceMcpConfig,
    onChanges: (paths: string[]) => Promise<void>,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    onDeletes?: (paths: string[]) => Promise<void>,
    opts?: StartOpts,
  ): Promise<void> {
    const run = this.opQueue.then(() =>
      this.startLocked(rootPath, config, onChanges, debounceMs, onDeletes, opts),
    );
    // Swallow rejections in the chain itself so one failed call doesn't wedge
    // every subsequent queued call — the actual error still propagates below.
    this.opQueue = run.catch(() => {});
    return run;
  }

  private async startLocked(
    rootPath: string,
    config: TraceMcpConfig,
    onChanges: (paths: string[]) => Promise<void>,
    debounceMs: number,
    onDeletes: ((paths: string[]) => Promise<void>) | undefined,
    opts: StartOpts | undefined,
  ): Promise<void> {
    this.lastStartArgs = {
      rootPath,
      config,
      onChanges,
      debounceMs,
      onDeletes,
      onRescan: opts?.onRescan,
    };
    // Re-entry guard: if start() is invoked again while a prior subscription is
    // live, the old AsyncSubscription (native fs-event handle + the registered
    // callback closure capturing onChanges/pipeline/traceignore) would leak.
    // Tear it down first so the new subscription is the sole owner. Safe to
    // call stopLocked() directly (bypassing the queue) since startLocked()
    // itself only ever runs serialized on the queue.
    if (this.subscription || this.debounceTimer) {
      await this.stopLocked();
    }

    const watcher = await loadParcelWatcher();
    const traceignore = new TraceignoreMatcher(rootPath, config.ignore ?? {});
    // Mirrors the full scan's ignore stack (IndexingPipeline.runPipeline) so a
    // gitignored file never reaches pipeline.indexFiles() on a watcher event
    // either — previously only .traceignore/config.exclude gated events here,
    // so gitignored log/DB churn re-ran the full pipeline every debounce cycle.
    const gitignore = new GitignoreMatcher(rootPath);
    const ignoreDirs = [...traceignore.getSkipDirs()].map((d) => path.join(rootPath, d));
    // config.exclude globs (e.g. **/storage/**, **/node_modules/**) gate
    // collectFiles() but historically NOT watcher events — so runtime churn
    // dirs excluded from full indexing (Laravel storage/framework/sessions,
    // caches) still triggered per-event reindexes. Apply the same globs here.
    const isExcluded = picomatch(config.exclude ?? [], { dot: true });
    const descendantGlobs = opts?.descendantExcludeGlobs ?? [];
    // Cheap per-event guard mirroring the native-level ignore below: covers
    // the race where a project is registered under this ancestor AFTER this
    // subscription was created (or removed just before) and the native
    // ignore list, snapshotted at subscribe-time, has gone stale until the
    // caller restarts us. See ProjectManager.addProject/removeProject.
    const isOwnedByDescendant = descendantGlobs.length
      ? picomatch(descendantGlobs, { dot: true })
      : undefined;

    this.subscription = await watcher.subscribe(
      rootPath,
      async (err, events) => {
        if (err) {
          if (isEventsDroppedError(err)) {
            // Don't just log: the events are gone, so nothing else will ever
            // reindex what changed in the lost window (TRA-852).
            logger.warn(
              { rootPath, error: String(err) },
              'File system events were dropped — reconciling index with disk',
            );
            this.runRescan(opts?.onRescan, rootPath);
            return;
          }
          logger.error({ error: err }, 'Watcher error');
          return;
        }

        const notIgnored = (p: string) => {
          if (ignoreDirs.some((d) => p.startsWith(d))) return false;
          const rel = path.relative(rootPath, p);
          if (isExcluded(rel.split(path.sep).join('/'))) return false;
          if (isOwnedByDescendant?.(rel.split(path.sep).join('/'))) return false;
          if (gitignore.isIgnored(rel)) return false;
          return !traceignore.isIgnored(rel);
        };

        const changed = events
          .filter((e) => e.type === 'create' || e.type === 'update')
          .map((e) => e.path)
          .filter(notIgnored);

        const deleted = events
          .filter((e) => e.type === 'delete')
          .map((e) => e.path)
          .filter(notIgnored);

        if (deleted.length > 0 && onDeletes) {
          logger.debug({ count: deleted.length }, 'File deletions detected');
          await onDeletes(deleted);
        }

        if (changed.length === 0) return;

        // Accumulate paths and debounce — multiple rapid saves collapse into one call
        for (const p of changed) this.pendingPaths.add(p);

        if (this.debounceTimer) this._clearTimeout(this.debounceTimer);
        this.debounceTimer = this._setTimeout(async () => {
          const paths = Array.from(this.pendingPaths);
          this.pendingPaths.clear();
          this.debounceTimer = null;
          logger.debug({ count: paths.length }, 'File changes detected');
          try {
            await onChanges(paths);
          } catch (e) {
            logger.error({ error: e }, 'File change handler failed');
          }
        }, debounceMs);
      },
      {
        // Native-level ignore: absolute top-level dirs PLUS nested globs.
        // `path.join(root, 'node_modules')` alone misses `<root>/sub/node_modules`
        // in monorepos/container roots — every nested dep change still woke the
        // process. Parcel matches globs relative to the watched root, so
        // `**/node_modules/**` and the config.exclude globs (storage/, caches)
        // drop those events before they ever cross the native→JS boundary.
        // descendantGlobs (e.g. `the/**`) do the same for registered
        // descendant project roots — a change under a descendant's subtree
        // never reaches this process's fs-event callback at all (#209).
        ignore: [
          ...ignoreDirs,
          ...[...traceignore.getSkipDirs()].map((d) => `**/${d}/**`),
          ...(config.exclude ?? []),
          ...descendantGlobs,
        ],
      },
    );

    logger.info({ rootPath }, 'File watcher started');
  }

  private runRescan(onRescan: (() => Promise<void>) | undefined, rootPath: string): void {
    if (!onRescan) return;
    if (this.rescanInFlight) {
      this.rescanPending = true;
      return;
    }
    this.rescanInFlight = true;
    void onRescan()
      .catch((e) => {
        logger.error({ error: e, rootPath }, 'Index reconcile after dropped events failed');
      })
      .finally(() => {
        this.rescanInFlight = false;
        if (this.rescanPending) {
          this.rescanPending = false;
          this.runRescan(onRescan, rootPath);
        }
      });
  }

  /**
   * Re-subscribe with a fresh `descendantExcludeGlobs` list, reusing every
   * other argument from the most recent `start()` call. Used by
   * ProjectManager when a project is registered/removed under an already-
   * running ancestor's watcher — the ancestor's ignore list was snapshotted
   * at subscribe-time and is now stale (#209). No-op if `start()` was never
   * called (e.g. a read-mostly project with `watch: false` — nothing to
   * restart) or already stopped.
   */
  async restartWithExcludes(descendantExcludeGlobs: string[]): Promise<void> {
    if (!this.lastStartArgs) {
      logger.debug('restartWithExcludes called before start() — ignoring');
      return;
    }
    const { rootPath, config, onChanges, debounceMs, onDeletes, onRescan } = this.lastStartArgs;
    await this.start(rootPath, config, onChanges, debounceMs, onDeletes, {
      descendantExcludeGlobs,
      onRescan,
    });
  }

  async stop(): Promise<void> {
    const run = this.opQueue.then(() => this.stopLocked());
    this.opQueue = run.catch(() => {});
    return run;
  }

  private async stopLocked(): Promise<void> {
    // Order matters: unsubscribe FIRST so parcel stops invoking our callback,
    // THEN drop the debounce timer. The opposite order leaves a window where
    // an in-flight parcel callback can schedule a new timer after we cleared
    // the old one — that timer would then fire post-stop with a captured
    // onChanges closure and run against torn-down state (e.g. closed DB).
    const sub = this.subscription;
    this.subscription = null;
    if (sub) {
      try {
        await sub.unsubscribe();
      } catch (err) {
        // Never abandon the lifecycle: even if the native handle is wedged
        // the reference must still be dropped (set above) so callers can
        // safely re-start. Log and move on.
        logger.warn({ error: err }, 'parcel watcher.unsubscribe() failed during stop');
      }
      logger.info('File watcher stopped');
    }
    if (this.debounceTimer) {
      this._clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingPaths.clear();
    // Don't let a queued follow-up reconcile fire after stop() — it would run
    // against torn-down state (closed DB). An already in-flight one can't be
    // cancelled; callers guard it with their own stopping flag.
    this.rescanPending = false;
  }
}
