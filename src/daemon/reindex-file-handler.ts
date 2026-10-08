import fs from 'node:fs';
import path from 'node:path';
import { LOCKS_DIR, projectHash } from '../global.js';
import type { IndexingPipeline, IndexingResult } from '../indexer/pipeline.js';
import { beginReindex, isReindexing } from '../indexer/reindex-inflight.js';
import { IndexAbortedError } from '../indexer/index-abort.js';
import { forgetRecentReindex, shouldSkipRecentReindex } from '../indexer/recent-reindex-cache.js';
import { logger } from '../logger.js';
import { isHotChurnPath } from '../utils/hot-churn.js';
import { isSelfLock, LockError, withLock } from '../utils/pid-lock.js';
import { getReindexStats } from './reindex-stats.js';

// TRA-1763: the in-flight registry lives in `indexer/reindex-inflight.ts` so
// the pipeline can mark its own runs without an indexer→daemon import.
// Re-exported here so existing callers keep working unchanged.
export {
  beginReindex,
  countReindexingProjects,
  isReindexing,
} from '../indexer/reindex-inflight.js';

export interface ReindexFileRequest {
  project: string;
  path: string;
}

export type ReindexFileResult =
  | {
      ok: true;
      relPath: string;
      skippedRecent?: boolean;
      skippedChurn?: boolean;
      /** #1480: accepted into the per-project queue; indexing has not run yet. */
      queued?: boolean;
    }
  | { ok: false; status: 400 | 404 | 500; error: string }
  | { ok: false; status: 503; error: string; retryAfterSec: number };

/**
 * Projects with a single-file reindex in flight right now.
 *
 * (Registry moved to `indexer/reindex-inflight.ts` in TRA-1763 — see the
 * re-export above. The TRA-1125 history below still applies.)
 *
 * TRA-1125: `projects_indexing` in the vitals line only ever counted projects
 * in the initial-load path — `project-manager.ts` sets `status = 'indexing'`
 * there. This handler *requires* status `ready` to proceed and never changes
 * it, so by construction every incremental reindex was logged as idle. In the
 * measured window 264 of 264 vitals samples reported `projects_indexing: 0`
 * while the daemon burned 99.3% CPU on a reindex burst, which made every
 * "idle RSS" figure in docs/perf a silent mix of idle and busy.
 */
/** How long `stopProject()` waits for in-flight single-file reindexes before
 *  closing the project DB anyway (TRA-1553). Single-file runs are typically
 *  tens of ms, so this binds only pathological cases; the daemon-wide
 *  `DAEMON_SHUTDOWN_DEADLINE_MS` still caps the whole shutdown. */
export const REINDEX_DRAIN_TIMEOUT_MS = 5_000;

/** Normalize the in-flight/stopping key: the HTTP path keys by the raw client
 *  string while `stopProject()` keys by the registration string, and the two
 *  can differ in trailing slashes or relative segments for the same project. */
function keyOf(project: string): string {
  return path.resolve(project);
}

/**
 * Projects currently being torn down by `stopProject()` (TRA-1553). Set
 * synchronously before the first teardown await so no interleaving can start
 * new pipeline work against a closing DB; cleared when the project leaves the
 * map (and defensively on re-add, in case a stop threw midway). A stale mark
 * can only cause 503-with-retry, never data loss.
 */
const stopping = new Set<string>();

/** Mark a project as tearing down. Idempotent. */
export function markProjectStopping(project: string): void {
  stopping.add(keyOf(project));
}

/** Clear the teardown mark. Idempotent. */
export function clearProjectStopping(project: string): void {
  stopping.delete(keyOf(project));
}

/** Whether new reindex work must be refused for this project. */
export function isProjectStopping(project: string): boolean {
  return stopping.has(keyOf(project));
}

/**
 * Wait until no reindex is in flight for `project`, or `timeoutMs` elapses.
 * Returns true when drained, false on timeout (the caller must proceed to
 * close anyway — a hung reindex must not wedge shutdown past its deadline).
 */
export async function waitForReindexDrain(project: string, timeoutMs: number): Promise<boolean> {
  if (!isReindexing(project)) return true;
  const deadline = Date.now() + timeoutMs;
  while (isReindexing(project)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

export interface ReindexFileDeps {
  getProject: (root: string) =>
    | {
        pipeline: Pick<IndexingPipeline, 'indexFiles'>;
        /** Phase 5.1: when present and not 'ready', handler returns 503. */
        status?: 'starting' | 'indexing' | 'ready' | 'error';
        /** Aborted by `stopProject()`; queued batches pass its signal down so
         *  a run in flight stops at its next phase boundary. */
        indexAbortController?: AbortController;
      }
    | undefined;
  /** Override withLock for tests. */
  lock?: typeof withLock;
  /** Override the queued-reindex retry schedule for tests (#1480). */
  queueRetry?: { delayMs?: number; maxDelayMs?: number; warnAfterMs?: number };
}

type ManagedReindexTarget = NonNullable<ReturnType<ReindexFileDeps['getProject']>>;

/** Outcome of the synchronous, pre-lock half of a reindex-file request. */
type PreparedReindexFile =
  | { kind: 'done'; result: ReindexFileResult }
  | {
      kind: 'run';
      project: string;
      rel: string;
      managed: ManagedReindexTarget;
      startedAt: number;
    };

/**
 * Validate, resolve, and dispatch a single-file reindex against a managed
 * project, and answer only once the indexing has finished. Shares the
 * `<projectHash>-reindex` lock with `register_edit` so the HTTP path and the
 * MCP path serialize on the same SQLite writer.
 *
 * The HTTP route uses this only when the caller asks for the result
 * (`?wait=1`); the PostToolUse hook and `trace-mcp index-file` go through
 * {@link acceptReindexFile}, which answers before the work runs (#1480).
 */
export async function handleReindexFile(
  body: Partial<ReindexFileRequest> | undefined,
  deps: ReindexFileDeps,
): Promise<ReindexFileResult> {
  const prepared = prepareReindexFile(body, deps);
  if (prepared.kind === 'done') return prepared.result;
  return runReindexFile(prepared, deps);
}

/**
 * Validate a reindex-file request and queue the indexing instead of waiting
 * for it (#1480). Validation, the 404/503 answers and the churn/recent
 * fast paths are identical to {@link handleReindexFile}; a request that
 * passes them is added to the project's pending set and the call returns
 * `{ ok: true, queued: true }` synchronously.
 *
 * WHY: the response used to be written only after `indexFiles()` — including
 * project-wide edge resolution — had finished. On a ~27k-symbol PHP project
 * that is ~2.4 s per file, so nearly every edit outran the hook's 2 s curl
 * timeout on a healthy daemon, got recorded as `no-daemon`, and spawned a
 * cold `trace-mcp index-file` that indexed the same file again (sometimes
 * locally, as a second SQLite writer). Nothing on the hook path consumes the
 * result, so the wait bought nothing.
 *
 * The queue drains under the same `<projectHash>-reindex` lock, coalesces
 * paths that arrive while a run is in flight into the next batch, retries
 * lock contention instead of dropping the edit, and holds the in-flight mark
 * until it is empty so `stopProject()` still drains it before closing the DB.
 */
export function acceptReindexFile(
  body: Partial<ReindexFileRequest> | undefined,
  deps: ReindexFileDeps,
): ReindexFileResult {
  const prepared = prepareReindexFile(body, deps);
  if (prepared.kind === 'done') return prepared.result;
  enqueueReindex(prepared.project, prepared.rel, prepared.startedAt, deps);
  return { ok: true, relPath: prepared.rel, queued: true };
}

/**
 * The synchronous half shared by both entry points: request validation,
 * project lookup and readiness, path confinement, and the churn / recent
 * fast paths. Everything here runs before the reindex lock is touched.
 */
function prepareReindexFile(
  body: Partial<ReindexFileRequest> | undefined,
  deps: ReindexFileDeps,
): PreparedReindexFile {
  const startedAt = performance.now();
  const project = body?.project;
  const rawPath = body?.path;

  if (typeof project !== 'string' || project.length === 0) {
    return { kind: 'done', result: { ok: false, status: 400, error: 'project is required' } };
  }
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { kind: 'done', result: { ok: false, status: 400, error: 'path is required' } };
  }

  const managed = deps.getProject(project);
  if (!managed) {
    // TRA-2032: this 404 used to be silent — the daemon logged nothing and the
    // hook stats carry no root, so a whole class of "hook always falls back to
    // cold CLI" failures was undiagnosable. Log the missed root (at info, not
    // warn: a stuck config points every Edit here and warn would spam) so the
    // next QA correlation is one grep away.
    logger.info(
      { event: 'reindex-file', project, path: rawPath, pathSource: 'http' },
      'reindex-file: project not registered',
    );
    return {
      kind: 'done',
      result: { ok: false, status: 404, error: `project not registered: ${project}` },
    };
  }

  // Phase 5.1: if the project is still warming (cold daemon, indexAll in
  // progress), tell the client to fall back transiently. The hook then takes
  // the local CLI path until the daemon finishes warming.
  if (managed.status !== undefined && managed.status !== 'ready') {
    return {
      kind: 'done',
      result: {
        ok: false,
        status: 503,
        error: `project not ready: ${managed.status}`,
        retryAfterSec: 5,
      },
    };
  }

  // TRA-1553: the project is being torn down — its DB is about to close (or
  // already closing) while this handler would still start pipeline work
  // against it. Same 503 contract as a warming project: hook clients honour
  // Retry-After and fall back to the local CLI path transparently.
  if (isProjectStopping(project)) {
    return {
      kind: 'done',
      result: { ok: false, status: 503, error: 'project is stopping', retryAfterSec: 5 },
    };
  }

  const projectRoot = path.resolve(project);
  const absInput = path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath);
  const normalized = path.resolve(absInput);

  let relRaw = path.relative(projectRoot, normalized);
  if (relRaw.startsWith('..') || path.isAbsolute(relRaw)) {
    // TRA-2032: mixed symlink spellings — e.g. a pre-v0.6 hook posts an alias
    // file path while the route already normalized the project to the stored
    // spelling (or vice versa) — fail the lexical check for the same on-disk
    // file. Retry confinement on realpaths; the resulting rel is identical
    // under both spellings because symlinks resolve above the root.
    let realRoot: string;
    let realInput: string;
    try {
      realRoot = fs.realpathSync(projectRoot);
      realInput = fs.realpathSync(normalized);
    } catch {
      return {
        kind: 'done',
        result: { ok: false, status: 400, error: 'path is outside project root' },
      };
    }
    relRaw = path.relative(realRoot, realInput);
    if (relRaw.startsWith('..') || path.isAbsolute(relRaw)) {
      return {
        kind: 'done',
        result: { ok: false, status: 400, error: 'path is outside project root' },
      };
    }
  }
  const rel = path.sep === '\\' ? relRaw.split('\\').join('/') : relRaw;

  // TRA-2021: hot-churn runtime state (`gateway.heartbeat`, `cron/ticker_*`,
  // `cron/.tick.lock`) is rewritten every ~30 s with an unchanged content
  // hash — indexing it only ever yields `skippedHash=true, indexed=0` after
  // queueing behind the reindex lock (47 s worst case observed). Answer
  // before `withLock` so the hook path never contends the lock for it. The
  // HTTP layer still returns 204 — callers don't need to know the work was
  // dropped.
  if (isHotChurnPath(rel)) {
    reportReindex(
      {
        project,
        path: rel,
        skippedChurn: true,
        indexed: 0,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
      'info',
      'reindex-file telemetry',
    );
    return { kind: 'done', result: { ok: true, relPath: rel, skippedChurn: true } };
  }

  // Phase 1.3 dedup: when a single Edit causes both the PostToolUse hook
  // and Claude's register_edit MCP call to fire, the second arrival within
  // 500 ms is a no-op. The HTTP layer still returns 204 — callers don't need
  // to know the work was deduped.
  if (shouldSkipRecentReindex(project, rel)) {
    reportReindex(
      {
        project,
        path: rel,
        skippedRecent: true,
        indexed: 0,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
      'info',
      'reindex-file telemetry',
    );
    return { kind: 'done', result: { ok: true, relPath: rel, skippedRecent: true } };
  }

  return { kind: 'run', project, rel, managed, startedAt };
}

/** One `reindex-file telemetry` event: the log line and the stats record. */
interface ReindexReport {
  project: string;
  path: string;
  indexed: number;
  /** Indexing work only (TRA-935). */
  elapsedMs: number;
  /** Wait before the work started. Omitted where there was no wait to report. */
  queuedMs?: number;
  skippedRecent?: boolean;
  skippedHash?: boolean;
  skippedChurn?: boolean;
  error?: boolean;
  /** Log-only fields: batch shape, holder attribution, the error itself. */
  extra?: Record<string, unknown>;
}

/** Shared by the synchronous path and the queue so the two cannot drift. */
function reportReindex(r: ReindexReport, level: 'info' | 'warn' | 'error', msg: string): void {
  const skippedRecent = r.skippedRecent ?? false;
  const skippedHash = r.skippedHash ?? false;
  const churn = r.skippedChurn ? { skippedChurn: true } : {};
  const queued = r.queuedMs !== undefined ? { queuedMs: r.queuedMs } : {};
  logger[level](
    {
      event: 'reindex-file',
      project: r.project,
      path: r.path,
      pathSource: 'http',
      skippedRecent,
      skippedHash,
      ...churn,
      indexed: r.indexed,
      elapsedMs: r.elapsedMs,
      ...queued,
      ...r.extra,
    },
    msg,
  );
  getReindexStats().record({
    pathSource: 'http',
    skippedRecent,
    skippedHash,
    ...churn,
    indexed: r.indexed,
    elapsedMs: r.elapsedMs,
    ...queued,
    ...(r.error ? { error: true } : {}),
  });
}

/**
 * TRA-935: report the indexing work and the wait in front of it as two
 * numbers. Summed into one they made a 30 ms reindex that sat behind a full
 * project pass look like a 40-minute reindex.
 */
function splitTiming(
  result: IndexingResult | undefined,
  waitingSince: number,
): { elapsedMs: number; queuedMs: number } {
  const totalMs = Math.round(performance.now() - waitingSince);
  const elapsedMs = result?.durationMs ?? totalMs;
  return { elapsedMs, queuedMs: Math.max(0, totalMs - elapsedMs) };
}

function lockOptions(project: string) {
  return { lockDir: LOCKS_DIR, name: `${projectHash(project)}-reindex`, op: 'reindex-file-http' };
}

/** Run one prepared request under the reindex lock and report its telemetry. */
async function runReindexFile(
  prepared: Extract<PreparedReindexFile, { kind: 'run' }>,
  deps: ReindexFileDeps,
): Promise<ReindexFileResult> {
  const { project, rel, managed, startedAt } = prepared;
  const lock = deps.lock ?? withLock;

  const endReindex = beginReindex(project);
  try {
    const result = (await lock(lockOptions(project), () => managed.pipeline.indexFiles([rel]))) as
      | IndexingResult
      | undefined;
    const indexed = result?.indexed ?? 0;
    const skipped = result?.skipped ?? 0;
    reportReindex(
      {
        project,
        path: rel,
        // Hash gate: the file was queued but indexFiles() returned a skipped
        // row instead of an indexed one — content hash matched the prior run.
        skippedHash: indexed === 0 && skipped > 0,
        indexed,
        ...splitTiming(result, startedAt),
      },
      'info',
      'reindex-file telemetry',
    );
    return { ok: true, relPath: rel };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    // TRA-2091: lock contention (including self-lock: this same daemon pid
    // already holding `<projectHash>-reindex` for an in-flight reindex) is
    // transient concurrency, not a crash. Answer 503 + Retry-After so hook
    // clients fall back to the local CLI path transparently (same contract
    // as warming/stopping), and log at warn with holder attribution instead
    // of L50.
    if (err instanceof LockError) {
      const holder = err.holder;
      const selfLock = isSelfLock(holder);
      reportReindex(
        {
          project,
          path: rel,
          indexed: 0,
          elapsedMs,
          error: true,
          extra: {
            lockBusy: true,
            selfLock,
            holder,
            holderOp: holder?.op,
            holderStartedAt: holder ? new Date(holder.started_at).toISOString() : undefined,
            holderStack: holder?.stack,
            err,
            error: String(err),
          },
        },
        'warn',
        selfLock ? 'reindex-file lock busy (self-lock, retry)' : 'reindex-file lock busy (retry)',
      );
      return {
        ok: false,
        status: 503,
        error: `reindex_in_progress: ${err.message}`,
        retryAfterSec: 5,
      };
    }
    reportReindex(
      {
        project,
        path: rel,
        indexed: 0,
        elapsedMs,
        error: true,
        extra: { err, error: String(err) },
      },
      'error',
      'reindex-file telemetry (error)',
    );
    return { ok: false, status: 500, error: String(err) };
  } finally {
    endReindex();
  }
}

/** First pause between attempts when a queued batch finds the reindex lock
 *  busy or the project still loading; doubles up to the max below. */
export const QUEUED_REINDEX_RETRY_DELAY_MS = 250;
export const QUEUED_REINDEX_RETRY_MAX_DELAY_MS = 2_000;
/** A queued batch that has waited this long logs one warn and keeps waiting.
 *  It is never dropped for waiting: the `reindex` tool holds the same lock for
 *  a whole `indexAll` (minutes on a large project), and the request was
 *  already answered 2xx and marked in the recent-reindex dedup cache, so the
 *  watcher and `register_edit` would skip this file — a dropped batch would
 *  stay out of the index until the next edit (#1480 review). A lock only
 *  stays busy while its holder process is alive; `acquireLock` reclaims a
 *  dead holder's lock on the next attempt. */
export const QUEUED_REINDEX_WAIT_WARN_MS = 30_000;
/** Paths per queued `indexFiles()` run. Keeps a single run — the unit
 *  `stopProject()`'s bounded drain waits on — close to a watcher batch. */
export const QUEUED_REINDEX_MAX_BATCH = 64;

interface PendingReindexQueue {
  /** Project spelling the requests used — the lock name, dedup cache and logs
   *  key off it. */
  project: string;
  /** Pending relative paths → when the first request for each was accepted. */
  paths: Map<string, number>;
  draining: boolean;
}

/** Per-project pending queues for {@link acceptReindexFile}. */
const pendingQueues = new Map<string, PendingReindexQueue>();

function enqueueReindex(
  project: string,
  rel: string,
  acceptedAt: number,
  deps: ReindexFileDeps,
): void {
  const key = keyOf(project);
  let queue = pendingQueues.get(key);
  if (!queue) {
    queue = { project, paths: new Map(), draining: false };
    pendingQueues.set(key, queue);
  }
  if (!queue.paths.has(rel)) queue.paths.set(rel, acceptedAt);
  if (queue.draining) return; // the running drain picks it up in a later batch
  queue.draining = true;
  // The in-flight mark is taken now, before the route writes its 202, so a
  // `stopProject()` that starts in between still waits for this work. The
  // work itself (lock acquire with its fsync, path filtering, indexing)
  // starts on the next turn — after the response is on the wire.
  const endReindex = beginReindex(project);
  const activeQueue = queue;
  setImmediate(() => {
    void drainReindexQueue(activeQueue, deps, endReindex);
  });
}

/** Drain one project's queue batch by batch until it is empty. */
async function drainReindexQueue(
  queue: PendingReindexQueue,
  deps: ReindexFileDeps,
  endReindex: () => void,
): Promise<void> {
  try {
    while (queue.paths.size > 0) {
      const batch = [...queue.paths.entries()].slice(0, QUEUED_REINDEX_MAX_BATCH);
      for (const [rel] of batch) queue.paths.delete(rel);
      try {
        await runQueuedBatch(queue.project, batch, deps);
      } catch (err) {
        // runQueuedBatch reports its own failures; this only guards the loop.
        logger.error(
          { event: 'reindex-file', project: queue.project, err, error: String(err) },
          'reindex-file queue drain failed',
        );
      }
    }
  } finally {
    // Nothing awaits between the loop's empty check and here, so no request
    // can have joined the queue in between.
    queue.draining = false;
    pendingQueues.delete(keyOf(queue.project));
    endReindex();
  }
}

function sleep(ms: number): Promise<void> {
  // unref: a pending retry must never be what keeps a process alive.
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

async function runQueuedBatch(
  project: string,
  batch: Array<[string, number]>,
  deps: ReindexFileDeps,
): Promise<void> {
  const rels = batch.map(([rel]) => rel);
  const lock = deps.lock ?? withLock;
  let delayMs = deps.queueRetry?.delayMs ?? QUEUED_REINDEX_RETRY_DELAY_MS;
  const maxDelayMs = deps.queueRetry?.maxDelayMs ?? QUEUED_REINDEX_RETRY_MAX_DELAY_MS;
  const warnAfterMs = deps.queueRetry?.warnAfterMs ?? QUEUED_REINDEX_WAIT_WARN_MS;
  const waitStartedAt = performance.now();
  let warned = false;
  const batchShape = { queued: true, batchSize: rels.length };

  // One record per path, never one per batch: each file's wait runs from its
  // own request, and `daemon stats` counts files, not batches.
  const drop = (reason: string, level: 'info' | 'warn', extra: Record<string, unknown> = {}) => {
    for (const [rel, acceptedAt] of batch) {
      // The request was marked in the recent-reindex dedup cache when it was
      // accepted. Unmark it, or the watcher / register_edit would skip this
      // file as "just reindexed" when it never was.
      forgetRecentReindex(project, rel);
      reportReindex(
        {
          project,
          path: rel,
          indexed: 0,
          // No indexing work ran; the time went to waiting, which is what
          // queuedMs carries — keeping it out of the work percentiles.
          elapsedMs: 0,
          queuedMs: Math.round(performance.now() - acceptedAt),
          error: true,
          extra: { ...batchShape, dropReason: reason, ...extra },
        },
        level,
        `reindex-file queued batch dropped: ${reason}`,
      );
    }
  };

  for (;;) {
    // The project may have been stopped or unloaded since the 202 — its DB is
    // closing or gone. A reload re-reads the file from disk.
    const managed = isProjectStopping(project) ? undefined : deps.getProject(project);
    if (!managed) {
      drop('project stopped or unloaded', 'info');
      return;
    }
    if (managed.status === 'error') {
      drop('project in error state', 'warn');
      return;
    }
    let lockErr: LockError | undefined;
    if (managed.status === undefined || managed.status === 'ready') {
      try {
        const result = (await lock(lockOptions(project), () =>
          managed.pipeline.indexFiles(rels, {
            signal: managed.indexAbortController?.signal,
          }),
        )) as IndexingResult | undefined;
        const indexedTotal = result?.indexed ?? 0;
        const skippedTotal = result?.skipped ?? 0;
        batch.forEach(([rel, acceptedAt], i) => {
          // indexFiles() reports counts for the batch, not per file, so the
          // split across files is positional: totals match, attribution of
          // a mixed batch is approximate.
          const indexed = i < indexedTotal ? 1 : 0;
          reportReindex(
            {
              project,
              path: rel,
              skippedHash: indexed === 0 && i - indexedTotal < skippedTotal,
              indexed,
              ...splitTiming(result, acceptedAt),
              extra: batchShape,
            },
            'info',
            'reindex-file telemetry',
          );
        });
        return;
      } catch (err) {
        if (err instanceof IndexAbortedError) {
          drop('project stopped mid-batch', 'info');
          return;
        }
        if (!(err instanceof LockError)) {
          drop('indexing failed', 'warn', { err, error: String(err) });
          return;
        }
        lockErr = err;
      }
    }
    // Lock busy (its holder is alive — a dead holder's lock is reclaimed on
    // the next attempt) or the project still loading: both end on their own,
    // so wait rather than lose the edit. The sync path answers 503 here and
    // lets its caller retry; nobody is waiting on a queued request.
    if (!warned && performance.now() - waitStartedAt >= warnAfterMs) {
      warned = true;
      const holder = lockErr?.holder ?? null;
      logger.warn(
        {
          event: 'reindex-file',
          project,
          path: rels[0],
          ...batchShape,
          waitedMs: Math.round(performance.now() - waitStartedAt),
          lockBusy: lockErr !== undefined,
          selfLock: isSelfLock(holder),
          holderOp: holder?.op,
          holderPid: holder?.pid,
          status: managed.status,
        },
        'reindex-file queued batch still waiting',
      );
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}
