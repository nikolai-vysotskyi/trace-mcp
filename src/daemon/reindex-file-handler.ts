import path from 'node:path';
import { LOCKS_DIR, projectHash } from '../global.js';
import type { IndexingPipeline } from '../indexer/pipeline.js';
import { shouldSkipRecentReindex } from '../indexer/recent-reindex-cache.js';
import { logger } from '../logger.js';
import { withLock } from '../utils/pid-lock.js';

export interface ReindexFileRequest {
  project: string;
  path: string;
}

export type ReindexFileResult =
  | { ok: true; relPath: string; skippedRecent?: boolean }
  | { ok: false; status: 400 | 404 | 500; error: string };

export interface ReindexFileDeps {
  getProject: (root: string) => { pipeline: Pick<IndexingPipeline, 'indexFiles'> } | undefined;
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

  const projectRoot = path.resolve(project);
  const absInput = path.isAbsolute(rawPath) ? rawPath : path.resolve(projectRoot, rawPath);
  const normalized = path.resolve(absInput);

  const rel = path.relative(projectRoot, normalized);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, status: 400, error: 'path is outside project root' };
  }

  // Phase 1.3 dedup: when a single Edit causes both the PostToolUse hook
  // and Claude's register_edit MCP call to fire, the second arrival within
  // 500 ms is a no-op. The HTTP layer still returns 204 — callers don't need
  // to know the work was deduped.
  if (shouldSkipRecentReindex(project, rel)) {
    return { ok: true, relPath: rel, skippedRecent: true };
  }

  const lock = deps.lock ?? withLock;

  try {
    await lock(
      { lockDir: LOCKS_DIR, name: `${projectHash(project)}-reindex`, op: 'reindex-file-http' },
      () => managed.pipeline.indexFiles([rel]),
    );
    return { ok: true, relPath: rel };
  } catch (err) {
    logger.error({ err, project, file: rel }, 'reindex-file HTTP endpoint failed');
    return { ok: false, status: 500, error: String(err) };
  }
}
