import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

import { handleReindexFile } from '../../src/daemon/reindex-file-handler.js';
import { __resetRecentReindexCache } from '../../src/indexer/recent-reindex-cache.js';

interface FakePipeline {
  indexFiles: ReturnType<typeof vi.fn>;
}

function makeDeps(opts?: { project?: string; pipelineThrows?: boolean }) {
  const indexFiles = vi.fn(async (_paths: string[]) => undefined);
  if (opts?.pipelineThrows) {
    indexFiles.mockRejectedValueOnce(new Error('boom'));
  }
  const pipeline: FakePipeline = { indexFiles };
  const lock = vi.fn(async (_opts, fn: () => Promise<unknown>) => fn());
  const projectRoot = opts?.project ?? '/tmp/proj-a';
  const getProject = vi.fn((root: string) => (root === projectRoot ? { pipeline } : undefined));
  return { getProject, lock, pipeline, indexFiles, projectRoot };
}

describe('handleReindexFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRecentReindexCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok on a valid project + relative path', async () => {
    const deps = makeDeps();
    const result = await handleReindexFile(
      { project: deps.projectRoot, path: 'src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result).toEqual({ ok: true, relPath: 'src/foo.ts' });
    expect(deps.indexFiles).toHaveBeenCalledWith(['src/foo.ts']);
    expect(deps.lock).toHaveBeenCalledTimes(1);
    const lockOpts = deps.lock.mock.calls[0][0] as { name: string; op: string };
    expect(lockOpts.name).toMatch(/-reindex$/);
    expect(lockOpts.op).toBe('reindex-file-http');
  });

  it('accepts an absolute path under the project root', async () => {
    const deps = makeDeps({ project: '/tmp/proj-a' });
    const result = await handleReindexFile(
      { project: '/tmp/proj-a', path: '/tmp/proj-a/src/bar.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result).toEqual({ ok: true, relPath: 'src/bar.ts' });
    expect(deps.indexFiles).toHaveBeenCalledWith(['src/bar.ts']);
  });

  it('returns 404 when the project is not registered', async () => {
    const deps = makeDeps();
    const result = await handleReindexFile(
      { project: '/tmp/unknown-project', path: 'src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toMatch(/not registered/);
    }
    expect(deps.indexFiles).not.toHaveBeenCalled();
  });

  it('returns 400 when project is missing', async () => {
    const deps = makeDeps();
    const result = await handleReindexFile(
      { path: 'src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/project/);
    }
  });

  it('returns 400 when path is missing', async () => {
    const deps = makeDeps();
    const result = await handleReindexFile(
      { project: deps.projectRoot },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/path/);
    }
  });

  it('returns 400 when path is an empty string', async () => {
    const deps = makeDeps();
    const result = await handleReindexFile(
      { project: deps.projectRoot, path: '' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('returns 400 on path traversal outside project root (relative)', async () => {
    const deps = makeDeps({ project: '/tmp/proj-a' });
    const result = await handleReindexFile(
      { project: '/tmp/proj-a', path: '../proj-b/src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/outside project root/);
    }
    expect(deps.indexFiles).not.toHaveBeenCalled();
  });

  it('returns 400 on path traversal outside project root (absolute)', async () => {
    const deps = makeDeps({ project: '/tmp/proj-a' });
    const result = await handleReindexFile(
      { project: '/tmp/proj-a', path: '/etc/passwd' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it('second call within 500 ms is deduped (skippedRecent=true) and pipeline is not invoked', async () => {
    const deps = makeDeps();
    const first = await handleReindexFile(
      { project: deps.projectRoot, path: 'src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.skippedRecent).toBeUndefined();
    expect(deps.indexFiles).toHaveBeenCalledTimes(1);

    const second = await handleReindexFile(
      { project: deps.projectRoot, path: 'src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.skippedRecent).toBe(true);
    expect(deps.indexFiles).toHaveBeenCalledTimes(1);
    expect(deps.lock).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the pipeline throws', async () => {
    const deps = makeDeps({ pipelineThrows: true });
    const result = await handleReindexFile(
      { project: deps.projectRoot, path: 'src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toMatch(/boom/);
    }
  });

  // Phase 5.1: cold daemon serves HTTP from millisecond zero; in-flight
  // requests against a still-warming project get 503 + Retry-After so the
  // hook fallback path takes over transparently.
  it('returns 503 with retryAfterSec when project status is indexing', async () => {
    const indexFiles = vi.fn(async (_paths: string[]) => undefined);
    const projectRoot = '/tmp/proj-cold';
    const getProject = vi.fn((root: string) =>
      root === projectRoot ? { pipeline: { indexFiles }, status: 'indexing' as const } : undefined,
    );
    const lock = vi.fn(async (_opts, fn: () => Promise<unknown>) => fn());

    const result = await handleReindexFile(
      { project: projectRoot, path: 'src/foo.ts' },
      { getProject, lock },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      if (result.status === 503) {
        expect(result.retryAfterSec).toBe(5);
        expect(result.error).toMatch(/not ready/);
      }
    }
    expect(indexFiles).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });

  it('returns 503 when project status is starting', async () => {
    const projectRoot = '/tmp/proj-cold';
    const getProject = vi.fn((root: string) =>
      root === projectRoot
        ? {
            pipeline: { indexFiles: vi.fn(async () => undefined) },
            status: 'starting' as const,
          }
        : undefined,
    );

    const result = await handleReindexFile(
      { project: projectRoot, path: 'src/foo.ts' },
      { getProject },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it('returns 503 when project status is error', async () => {
    const projectRoot = '/tmp/proj-cold';
    const getProject = vi.fn((root: string) =>
      root === projectRoot
        ? {
            pipeline: { indexFiles: vi.fn(async () => undefined) },
            status: 'error' as const,
          }
        : undefined,
    );

    const result = await handleReindexFile(
      { project: projectRoot, path: 'src/foo.ts' },
      { getProject },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it('processes normally when project status is ready', async () => {
    const indexFiles = vi.fn(async (_paths: string[]) => undefined);
    const projectRoot = '/tmp/proj-ready';
    const getProject = vi.fn((root: string) =>
      root === projectRoot ? { pipeline: { indexFiles }, status: 'ready' as const } : undefined,
    );
    const lock = vi.fn(async (_opts, fn: () => Promise<unknown>) => fn());

    const result = await handleReindexFile(
      { project: projectRoot, path: 'src/foo.ts' },
      { getProject, lock },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.relPath).toBe('src/foo.ts');
    expect(indexFiles).toHaveBeenCalledWith(['src/foo.ts']);
  });

  it('processes normally when status field is absent (back-compat)', async () => {
    // Pre-Phase-5.1 fakes don't supply status; handler must not 503 them.
    const indexFiles = vi.fn(async (_paths: string[]) => undefined);
    const projectRoot = '/tmp/proj-no-status';
    const getProject = vi.fn((root: string) =>
      root === projectRoot ? { pipeline: { indexFiles } } : undefined,
    );
    const lock = vi.fn(async (_opts, fn: () => Promise<unknown>) => fn());

    const result = await handleReindexFile(
      { project: projectRoot, path: 'src/foo.ts' },
      { getProject, lock },
    );

    expect(result.ok).toBe(true);
    expect(indexFiles).toHaveBeenCalledWith(['src/foo.ts']);
  });
});
