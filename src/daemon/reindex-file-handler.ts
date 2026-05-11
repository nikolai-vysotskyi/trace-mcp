import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { LOCKS_DIR, projectHash } from '../global.js';
import type { IndexingPipeline, IndexingResult } from '../indexer/pipeline.js';
import { shouldSkipRecentReindex } from '../indexer/recent-reindex-cache.js';
import { logger } from '../logger.js';
import { withLock } from '../utils/pid-lock.js';
import { getReindexStats } from './reindex-stats.js';

export interface ReindexFileRequest {
  project: string;
  path: string;
}

export type ReindexFileResult =
  | { ok: true; relPath: string; skippedRecent?: boolean }
  | { ok: false; status: 400 | 404 | 500; error: string }
  | { ok: false; status: 503; error: string; retryAfterSec: number };

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

  try {
    const result = (await lock(
      { lockDir: LOCKS_DIR, name: `${projectHash(project)}-reindex`, op: 'reindex-file-http' },
      () => managed.pipeline.indexFiles([rel]),
    )) as IndexingResult | undefined;
    const indexed = result?.indexed ?? 0;
    const skipped = result?.skipped ?? 0;
    const skippedHash = indexed === 0 && skipped > 0;
    const elapsedMs = Math.round(performance.now() - startedAt);
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
      },
      'reindex-file telemetry',
    );
    getReindexStats().record({
      pathSource: 'http',
      skippedRecent: false,
      skippedHash,
      indexed,
      elapsedMs,
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
  }
}
