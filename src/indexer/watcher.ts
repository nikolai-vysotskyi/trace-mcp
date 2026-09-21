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

/**
 * Process-wide tally of drop reports, the reconcile passes they triggered,
 * and the reports the storm breaker coalesced instead of running immediately.
 * Reported by `get_index_health` and the daemon vitals line so a session can
 * tell "the OS never dropped anything" from "it dropped events and the repair
 * did/didn't run" — a distinction that otherwise only exists in the daemon
 * log, which the agent asking the question cannot read (TRA-813).
 */
const droppedEventStats = { drops: 0, reconciles: 0, suppressed: 0 };

export function getDroppedEventStats(): { drops: number; reconciles: number; suppressed: number } {
  return { ...droppedEventStats };
}

/** Test-only reset — the tally is module state shared by every watcher. */
export function resetDroppedEventStats(): void {
  droppedEventStats.drops = 0;
  droppedEventStats.reconciles = 0;
  droppedEventStats.suppressed = 0;
}

/**
 * Storm backoff for dropped-event reconciles (TRA-1665).
 *
 * A watcher on a directory with intense artifact churn (build/ML run outputs
 * written continuously) overflows the OS event queue over and over: every
 * drop used to trigger its own full-walk reconcile, so one root re-walked
 * ~10k files every minute for as long as the run lasted. The in-flight
 * collapse in `runRescan` only helps bursts — it cannot help a sustained
 * storm where each pass finishes before the next drop arrives.
 *
 * Once `RECONCILE_STORM_THRESHOLD` drops land inside `RECONCILE_STORM_WINDOW_MS`,
 * the breaker opens for `RECONCILE_STORM_COOLDOWN_MS`: further drops are
 * counted (`suppressed`) and collapse into a single trailing full-walk when the
 * cooldown elapses, instead of a walk per drop. The threshold-crossing drop
 * itself still runs immediately — the index covers the lost window up to now,
 * and the trailing pass covers the rest, so no window is ever skipped, only
 * deferred.
 */
export const RECONCILE_STORM_WINDOW_MS = 5 * 60_000;
export const RECONCILE_STORM_THRESHOLD = 3;
export const RECONCILE_STORM_COOLDOWN_MS = 5 * 60_000;

/** Test seam for the storm breaker clock and thresholds. */
export interface WatcherStormTuning {
  now?: () => number;
  stormWindowMs?: number;
  stormThreshold?: number;
  stormCooldownMs?: number;
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
  /** The reconcile pass currently running, or null. Guards against a rescan
   *  stampede (FSEvents drops arrive in bursts and each pass walks the whole
   *  root): at most one runs at a time, and drops seen while one is in flight
   *  collapse into a single follow-up pass. Also what `stop()` awaits — the
   *  pass holds a pipeline the caller disposes right after stop() returns. */
  private activeRescan: Promise<void> | null = null;
  private rescanPending = false;
  /**
   * Storm-breaker state (TRA-1665), per watcher instance — a storm is always
   * about one root's churn, never the process. `dropTimestamps` holds the
   * recent drop-report times inside the sliding window; `stormQuietUntilMs`
   * is the instant an open breaker closes; `stormPending` is the single
   * trailing pass the suppressed drops collapse into.
   */
  private dropTimestamps: number[] = [];
  private stormQuietUntilMs = 0;
  private stormCoalesced = 0;
  private stormPending: { onRescan: () => Promise<void>; rootPath: string } | null = null;
  private stormTimer: ReturnType<typeof setTimeout> | null = null;
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
  /**
   * Handler runs currently executing. Unsubscribing stops future events and
   * clearing the debounce timer stops a scheduled run, but neither touches a
   * run whose timer has already fired — that one is mid-`onChanges`/`onDeletes`,
   * indexing into a Store the caller is about to close (TRA-834). `stop()` awaits these
   * so "the watcher is stopped" means no handler is still running.
   *
   * A set, not a single reference: nothing serializes handlers, so a second
   * burst can fire while the first is still indexing. With one slot the second
   * run overwrites the first and, if it finishes quickly, clears the slot —
   * `stop()` would then return while the first is still writing.
   */
  private readonly activeHandlers = new Set<Promise<void>>();

  /**
   * Register an already-started handler run so `stop()` waits it out. The
   * tracked copy swallows errors so `stop()`'s `Promise.all` can only wait,
   * never throw; the caller still sees the original rejection.
   */
  private track(run: Promise<void>): Promise<void> {
    const tracked: Promise<void> = run
      .catch(() => {})
      .finally(() => {
        this.activeHandlers.delete(tracked);
      });
    this.activeHandlers.add(tracked);
    return run;
  }

  constructor(
    private readonly _setTimeout: typeof setTimeout = setTimeout,
    private readonly _clearTimeout: typeof clearTimeout = clearTimeout,
    stormTuning: WatcherStormTuning = {},
  ) {
    this.stormTuning = {
      now: stormTuning.now ?? Date.now,
      stormWindowMs: stormTuning.stormWindowMs ?? RECONCILE_STORM_WINDOW_MS,
      stormThreshold: stormTuning.stormThreshold ?? RECONCILE_STORM_THRESHOLD,
      stormCooldownMs: stormTuning.stormCooldownMs ?? RECONCILE_STORM_COOLDOWN_MS,
    };
  }

  private readonly stormTuning: {
    now: () => number;
    stormWindowMs: number;
    stormThreshold: number;
    stormCooldownMs: number;
  };

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
            droppedEventStats.drops++;
            // Don't just log: the events are gone, so nothing else will ever
            // reindex what changed in the lost window (TRA-852). Under a
            // sustained storm the breaker defers this drop into one trailing
            // pass instead of a full-walk per drop (TRA-1665).
            if (!this.deferStormDrop(opts?.onRescan, rootPath, err)) {
              logger.warn(
                { rootPath, error: String(err) },
                'File system events were dropped — reconciling index with disk',
              );
              this.runRescan(opts?.onRescan, rootPath);
            }
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
          await this.track(onDeletes(deleted));
        }

        if (changed.length === 0) return;

        // Accumulate paths and debounce — multiple rapid saves collapse into one call
        for (const p of changed) this.pendingPaths.add(p);

        if (this.debounceTimer) this._clearTimeout(this.debounceTimer);
        this.debounceTimer = this._setTimeout(() => {
          const paths = Array.from(this.pendingPaths);
          this.pendingPaths.clear();
          this.debounceTimer = null;
          logger.debug({ count: paths.length }, 'File changes detected');
          void this.track(
            (async () => {
              try {
                await onChanges(paths);
              } catch (e) {
                logger.error({ error: e }, 'File change handler failed');
              }
            })(),
          );
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

  /**
   * Storm-breaker gate for a dropped-events report (TRA-1665). Returns true
   * when this drop was coalesced into the deferred trailing pass (the caller
   * must then skip both the warn and the immediate `runRescan`), false when
   * the caller should proceed exactly as before.
   *
   * Callers without an `onRescan` never reconcile, so there is nothing to
   * defer — they always take the legacy path.
   */
  private deferStormDrop(
    onRescan: (() => Promise<void>) | undefined,
    rootPath: string,
    err: unknown,
  ): boolean {
    if (!onRescan) return false;
    const now = this.stormTuning.now();
    const windowStart = now - this.stormTuning.stormWindowMs;
    this.dropTimestamps = this.dropTimestamps.filter((t) => t >= windowStart);
    this.dropTimestamps.push(now);

    if (now < this.stormQuietUntilMs) {
      // Breaker open: count and collapse. One trailing pass already covers
      // everything since the storm began, so an immediate walk would only
      // re-walk churn that is still being written.
      droppedEventStats.suppressed++;
      this.stormCoalesced++;
      this.stormPending = { onRescan, rootPath };
      this.ensureStormTimer();
      logger.debug(
        { rootPath, coalesced: this.stormCoalesced },
        'Reconcile storm in progress — drop coalesced into deferred full-walk',
      );
      return true;
    }

    if (this.dropTimestamps.length >= this.stormTuning.stormThreshold) {
      // Storm onset. This drop still runs immediately via the caller, so the
      // lost window up to now is covered; the breaker only throttles what
      // comes after, and the trailing pass covers that tail.
      this.stormQuietUntilMs = now + this.stormTuning.stormCooldownMs;
      this.stormCoalesced = 0;
      logger.warn(
        {
          rootPath,
          error: String(err),
          dropsInWindow: this.dropTimestamps.length,
          cooldownMs: this.stormTuning.stormCooldownMs,
        },
        'Reconcile storm detected — deferring further full-walks to one trailing pass after cooldown',
      );
    }
    return false;
  }

  /**
   * Arms the single trailing pass for an open breaker. Idempotent: further
   * suppressed drops only refresh `stormPending`, never arm a second timer.
   * The timer fires once at the breaker's close and routes through the normal
   * `runRescan` path, so in-flight collapse and `stop()` draining apply.
   */
  private ensureStormTimer(): void {
    if (this.stormTimer || !this.stormPending) return;
    const delay = Math.max(0, this.stormQuietUntilMs - this.stormTuning.now());
    this.stormTimer = this._setTimeout(() => {
      this.stormTimer = null;
      const pending = this.stormPending;
      this.stormPending = null;
      // Close the breaker BEFORE running so drops landing during the trailing
      // pass take the normal path (in-flight collapse) instead of re-arming.
      this.stormQuietUntilMs = 0;
      this.dropTimestamps = [];
      const coalesced = this.stormCoalesced;
      this.stormCoalesced = 0;
      if (pending) {
        logger.warn(
          { rootPath: pending.rootPath, coalescedDrops: coalesced },
          'Reconcile storm cooldown elapsed — running deferred full-walk',
        );
        this.runRescan(pending.onRescan, pending.rootPath);
      }
    }, delay);
  }

  private runRescan(onRescan: (() => Promise<void>) | undefined, rootPath: string): void {
    if (!onRescan) return;
    if (this.activeRescan) {
      this.rescanPending = true;
      return;
    }
    droppedEventStats.reconciles++;
    this.activeRescan = onRescan()
      .catch((e) => {
        logger.error({ error: e, rootPath }, 'Index reconcile after dropped events failed');
      })
      .finally(() => {
        this.activeRescan = null;
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

  /**
   * Drop the native subscription and all pending (not yet started) work
   * WITHOUT waiting for in-flight handlers/rescans (TRA-1017). Stops new
   * work at the source in milliseconds; pair with `drain()` once every
   * producer that could still touch the DB has been cancelled, and bound
   * that wait — `stop()`'s combined unsubscribe+drain can outlast a shutdown
   * budget when a handler is queued behind a minutes-long pipeline run.
   */
  async unsubscribe(): Promise<void> {
    const run = this.opQueue.then(() => this.unsubscribeLocked());
    this.opQueue = run.catch(() => {});
    return run;
  }

  /**
   * Wait out the in-flight rescan/handlers `unsubscribe()` deliberately left
   * running (TRA-1017). Ordered after `unsubscribe()` through the same op
   * queue. The caller must have cancelled the underlying pipeline work first
   * (its abort makes these settle at their next boundary) and must bound
   * this wait — a handler queued on a wedged pipeline lock settles only via
   * that cancellation or not at all.
   */
  async drain(): Promise<void> {
    const run = this.opQueue.then(() => this.drainLocked());
    this.opQueue = run.catch(() => {});
    return run;
  }

  private async stopLocked(): Promise<void> {
    await this.unsubscribeLocked();
    await this.drainLocked();
  }

  private async unsubscribeLocked(): Promise<void> {
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
    // A storm-breaker trailing pass must never fire post-stop against a
    // disposed pipeline: drop the collapsed work (its window is already
    // covered by the last completed pass as far as it goes; the next start
    // re-walks anyway) and disarm the timer. A trailing pass already running
    // is awaited via `activeRescan` below.
    if (this.stormTimer) {
      this._clearTimeout(this.stormTimer);
      this.stormTimer = null;
    }
    this.stormPending = null;
    this.stormQuietUntilMs = 0;
    this.stormCoalesced = 0;
    this.dropTimestamps = [];
    // (Drain half — see drainLocked().)
  }

  private async drainLocked(): Promise<void> {
    // A reconcile pass holds the caller's pipeline, and callers dispose it as
    // soon as stop() returns. Drop any queued follow-up (cleared first, so the
    // in-flight pass's `finally` doesn't start one) and wait out the active
    // pass rather than letting it resume against a closed DB.
    this.rescanPending = false;
    if (this.activeRescan) await this.activeRescan;
    // Same for every handler whose debounce timer had already fired before we got
    // here. Without this the caller closes the DB out from under a running
    // indexing pass (TRA-834). Each run swallows its own errors, so this can
    // only wait, never throw.
    await Promise.all(this.activeHandlers);
  }
}
