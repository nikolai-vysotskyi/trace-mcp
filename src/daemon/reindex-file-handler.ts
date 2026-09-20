import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { LOCKS_DIR, projectHash } from '../global.js';
import type { IndexingPipeline, IndexingResult } from '../indexer/pipeline.js';
import { beginReindex, isReindexing } from '../indexer/reindex-inflight.js';
import { shouldSkipRecentReindex } from '../indexer/recent-reindex-cache.js';
import { logger } from '../logger.js';
import { withLock } from '../utils/pid-lock.js';
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
  | { ok: true; relPath: string; skippedRecent?: boolean }
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
      }
    | undefined;
  /** Override withLock for tests. */
  lock?: typeof withLock;
}

/**
 * Validate, resolve, and dispatch a single-file reindex against a managed
 * project. Shares the `<projectHash>-reindex` lock with `register_edit` so the
 * HTTP path and the MCP path serialize on the same SQLite writer.
 */
export async function handleReindexFile(
  body: Partial<ReindexFileRequest> | undefined,
  deps: ReindexFileDeps,
): Promise<ReindexFileResult> {
  const startedAt = performance.now();
  const project = body?.project;
  const rawPath = body?.path;

  if (typeof project !== 'string' || project.length === 0) {
    return { ok: false, status: 400, error: 'project is required' };
  }
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { ok: false, status: 400, error: 'path is required' };
  }

  const managed = deps.getProject(project);
  if (!managed) {
    return { ok: false, status: 404, error: `project not registered: ${project}` };
  }

  // Phase 5.1: if the project is still warming (cold daemon, indexAll in
  // progress), tell the client to fall back transiently. The hook then takes
  // the local CLI path until the daemon finishes warming.
  if (managed.status !== undefined && managed.status !== 'ready') {
    return {
      ok: false,
      status: 503,
      error: `project not ready: ${managed.status}`,
      retryAfterSec: 5,
    };
  }

  // TRA-1553: the project is being torn down — its DB is about to close (or
  // already closing) while this handler would still start pipeline work
  // against it. Same 503 contract as a warming project: hook clients honour
  // Retry-After and fall back to the local CLI path transparently.
  if (isProjectStopping(project)) {
    return {
      ok: false,
      status: 503,
      error: 'project is stopping',
      retryAfterSec: 5,
    };
  }

  const projectRoot = path.resolve(project);
  const absInput = path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath);
  const normalized = path.resolve(absInput);

  const relRaw = path.relative(projectRoot, normalized);
  if (relRaw.startsWith('..') || path.isAbsolute(relRaw)) {
    return { ok: false, status: 400, error: 'path is outside project root' };
  }
  const rel = path.sep === '\\' ? relRaw.split('\\').join('/') : relRaw;

  // Phase 1.3 dedup: when a single Edit causes both the PostToolUse hook
  // and Claude's register_edit MCP call to fire, the second arrival within
  // 500 ms is a no-op. The HTTP layer still returns 204 — callers don't need
  // to know the work was deduped.
  if (shouldSkipRecentReindex(project, rel)) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    logger.info(
      {
        event: 'reindex-file',
        project,
        path: rel,
        pathSource: 'http',
        skippedRecent: true,
        skippedHash: false,
        indexed: 0,
        elapsedMs,
      },
      'reindex-file telemetry',
    );
    getReindexStats().record({
      pathSource: 'http',
      skippedRecent: true,
      skippedHash: false,
      indexed: 0,
      elapsedMs,
    });
    return { ok: true, relPath: rel, skippedRecent: true };
  }

  const lock = deps.lock ?? withLock;

  const endReindex = beginReindex(project);
  try {
    const result = (await lock(
      { lockDir: LOCKS_DIR, name: `${projectHash(project)}-reindex`, op: 'reindex-file-http' },
      () => managed.pipeline.indexFiles([rel]),
    )) as IndexingResult | undefined;
    const indexed = result?.indexed ?? 0;
    const skipped = result?.skipped ?? 0;
    const skippedHash = indexed === 0 && skipped > 0;
    // TRA-935: report the indexing work and the wait for the reindex lock as
    // two numbers. Summed into one they made a 30 ms reindex that sat behind a
    // full project pass look like a 40-minute reindex.
    const totalMs = Math.round(performance.now() - startedAt);
    const elapsedMs = result?.durationMs ?? totalMs;
    const queuedMs = Math.max(0, totalMs - elapsedMs);
    logger.info(
      {
        event: 'reindex-file',
        project,
        path: rel,
        pathSource: 'http',
        skippedRecent: false,
        // Hash gate: the file was queued but indexFiles() returned a skipped
        // row instead of an indexed one — content hash matched the prior run.
        skippedHash,
        indexed,
        elapsedMs,
        queuedMs,
      },
      'reindex-file telemetry',
    );
    getReindexStats().record({
      pathSource: 'http',
      skippedRecent: false,
      skippedHash,
      indexed,
      elapsedMs,
      queuedMs,
    });
    return { ok: true, relPath: rel };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    logger.error(
      {
        event: 'reindex-file',
        project,
        path: rel,
        pathSource: 'http',
        skippedRecent: false,
        skippedHash: false,
        indexed: 0,
        elapsedMs,
        err,
        error: String(err),
      },
      'reindex-file telemetry (error)',
    );
    getReindexStats().record({
      pathSource: 'http',
      skippedRecent: false,
      skippedHash: false,
      indexed: 0,
      elapsedMs,
      error: true,
    });
    return { ok: false, status: 500, error: String(err) };
  } finally {
    endReindex();
  }
}
