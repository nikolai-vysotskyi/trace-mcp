import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  logger: loggerMocks,
}));

import { handleReindexFile } from '../../src/daemon/reindex-file-handler.js';
import { __resetReindexStatsForTests, getReindexStats } from '../../src/daemon/reindex-stats.js';
import { __resetRecentReindexCache } from '../../src/indexer/recent-reindex-cache.js';

interface FakePipeline {
  indexFiles: ReturnType<typeof vi.fn>;
}

function makeDeps(opts?: { indexed?: number; skipped?: number; project?: string }) {
  const projectRoot = opts?.project ?? '/tmp/dispatch-tel-proj';
  const indexFiles = vi.fn(async (_paths: string[]) => ({
    totalFiles: 1,
    indexed: opts?.indexed ?? 1,
    skipped: opts?.skipped ?? 0,
    errors: 0,
    durationMs: 5,
  }));
  const pipeline: FakePipeline = { indexFiles };
  const lock = vi.fn(async (_o, fn: () => Promise<unknown>) => fn());
  const getProject = vi.fn((root: string) => (root === projectRoot ? { pipeline } : undefined));
  return { getProject, lock, indexFiles, projectRoot };
}

function findTelemetryEvent(): Record<string, unknown> | null {
  for (const call of loggerMocks.info.mock.calls) {
    const [payload, msg] = call as [Record<string, unknown>, string];
    if (msg === 'reindex-file telemetry') return payload;
  }
  return null;
}

describe('handleReindexFile telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRecentReindexCache();
    __resetReindexStatsForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits telemetry on a successful indexed run', async () => {
    const deps = makeDeps({ indexed: 1, skipped: 0 });
    const result = await handleReindexFile(
      { project: deps.projectRoot, path: 'src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result.ok).toBe(true);

    const ev = findTelemetryEvent();
    expect(ev).toBeTruthy();
    expect(ev?.event).toBe('reindex-file');
    expect(ev?.project).toBe(deps.projectRoot);
    expect(ev?.path).toBe('src/foo.ts');
    expect(ev?.pathSource).toBe('http');
    expect(ev?.skippedRecent).toBe(false);
    expect(ev?.skippedHash).toBe(false);
    expect(ev?.indexed).toBe(1);
    expect(typeof ev?.elapsedMs).toBe('number');
    expect((ev?.elapsedMs as number) >= 0).toBe(true);
  });

  it('marks skippedHash=true when indexFiles returns skipped > 0 and indexed === 0', async () => {
    const deps = makeDeps({ indexed: 0, skipped: 1 });
    const result = await handleReindexFile(
      { project: deps.projectRoot, path: 'src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result.ok).toBe(true);

    const ev = findTelemetryEvent();
    expect(ev?.skippedHash).toBe(true);
    expect(ev?.skippedRecent).toBe(false);
    expect(ev?.indexed).toBe(0);
  });

  it('marks skippedRecent=true on dedup hit', async () => {
    const deps = makeDeps();
    await handleReindexFile(
      { project: deps.projectRoot, path: 'src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    loggerMocks.info.mockClear();

    const result = await handleReindexFile(
      { project: deps.projectRoot, path: 'src/foo.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skippedRecent).toBe(true);

    const ev = findTelemetryEvent();
    expect(ev?.skippedRecent).toBe(true);
    expect(ev?.skippedHash).toBe(false);
    expect(ev?.indexed).toBe(0);
  });

  it('records into the in-memory ReindexStats ring', async () => {
    const deps = makeDeps({ indexed: 1 });
    await handleReindexFile(
      { project: deps.projectRoot, path: 'src/a.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    await handleReindexFile(
      { project: deps.projectRoot, path: 'src/b.ts' },
      { getProject: deps.getProject, lock: deps.lock },
    );
    const summary = getReindexStats().summarize();
    expect(summary.total).toBe(2);
    expect(summary.indexed).toBe(2);
    expect(summary.fast_skipped_hash).toBe(0);
    expect(summary.fast_skipped_recent).toBe(0);
  });
});
