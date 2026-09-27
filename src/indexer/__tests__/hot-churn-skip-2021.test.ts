/**
 * TRA-2021: hot-churn runtime-state files (`state/gateway.heartbeat`,
 * `cron/ticker_*`, `cron/.tick.lock`) burned ~250 s of indexer-elapsed per
 * hour on one project — every ~30 s rewrite queued behind the reindex lock
 * and reported lock-wait as latency (47 s worst case) for `indexed: 0`,
 * and the stalls starved /health until 31 sessions flipped to
 * local-fallback on a live daemon.
 *
 * Churn state is engine scratch, never source (same argument as TRA-1943
 * for SQLite sidecars), so every indexing entry point drops it before any
 * stat/read/lock:
 *
 *  1. `isHotChurnPath` matches the three shapes and nothing else (no false
 *     positives on `cronjobs/`, `my-ticker_service.ts`, or files nested
 *     under a `cron`-named directory that are not `ticker_*`).
 *  2. `collectFiles` (full walk) never lists them.
 *  3. `FileExtractor` skips them pre-read (safety net for direct callers).
 *  4. `indexFiles` on churn-only watcher traffic is a zero-work no-op.
 *  5. `FileWatcher` drops churn events before debounce, so they never wake
 *     the pipeline at all.
 *  6. `handleReindexFile` (HTTP hook path) answers `skippedChurn` before
 *     `withLock` — the hook never contends the reindex lock for these.
 *  7. The churn drops are observable: `summarize()` counts
 *     `fast_skipped_churn`, and `renderDaemonEvents` shows the line only
 *     when non-zero (older daemons render unchanged).
 */
import * as parcelWatcher from '@parcel/watcher';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn(),
}));

import { renderDaemonEvents } from '../../cli/daemon-stats.js';
import { TraceMcpConfigSchema } from '../../config.js';
import { handleReindexFile } from '../../daemon/reindex-file-handler.js';
import { __resetReindexStatsForTests, getReindexStats } from '../../daemon/reindex-stats.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { isHotChurnPath } from '../../utils/hot-churn.js';
import type { IndexingResult } from '../pipeline.js';
import type { withLock } from '../../utils/pid-lock.js';
import { collectFiles } from '../file-collector.js';
import { FileExtractor } from '../file-extractor.js';
import { IndexingPipeline } from '../pipeline.js';
import { buildProjectContext } from '../project-context.js';
import { FileWatcher } from '../watcher.js';

function makeExtractor(rootPath: string): FileExtractor {
  return new FileExtractor({
    registry: PluginRegistry.createWithDefaults(),
    rootPath,
    workspaces: [],
    gitignore: undefined,
    fileContentCache: new Map(),
    buildProjectContext: () => buildProjectContext(rootPath),
    existingFiles: new Map(),
  });
}

describe('isHotChurnPath (TRA-2021)', () => {
  it.each([
    'state/gateway.heartbeat',
    'gateway.heartbeat',
    '.hermes/state/gateway.heartbeat',
    'cron/ticker_1',
    'cron/ticker_abc123',
    '.hermes/cron/ticker_9',
    'cron/.tick.lock',
    '.tick.lock',
    '.hermes/cron/.tick.lock',
    'C:\\proj\\state\\gateway.heartbeat',
    'C:\\proj\\cron\\ticker_1',
  ])('matches hot churn %s', (p) => {
    expect(isHotChurnPath(p)).toBe(true);
  });

  it.each([
    'src/a.ts',
    'state/gateway.ts',
    'cron/runner.ts',
    // `ticker_` outside a whole-segment `cron` dir is a normal source name.
    'src/ticker_service.ts',
    'jobs/ticker_1.ts',
    'cronjobs/ticker_1',
    // Substring dirs must not match: `cronjobs` is not `cron`.
    'mycron/ticker_1',
    // A directory ending in `.tick.lock` must not nuke the files inside it.
    'snapshots/.tick.lock/report.ts',
    'state/gateway.heartbeat.bak',
    'heartbeat.md',
  ])('does not match %s', (p) => {
    expect(isHotChurnPath(p)).toBe(false);
  });
});

describe('collectFiles drops hot churn (TRA-2021)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'trace-mcp-churn-collect-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('lists sources but never heartbeat/ticker/lock state', async () => {
    mkdirSync(join(workDir, 'state'), { recursive: true });
    mkdirSync(join(workDir, 'cron'), { recursive: true });
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'state', 'gateway.heartbeat'), '{"ts":1}\n');
    writeFileSync(join(workDir, 'cron', 'ticker_1'), 'tick\n');
    writeFileSync(join(workDir, 'cron', '.tick.lock'), 'lock\n');
    writeFileSync(join(workDir, 'src', 'a.ts'), 'export const a = 1;\n');

    const config = TraceMcpConfigSchema.parse({ include: ['**/*'], exclude: [] });
    const result = await collectFiles({
      config,
      rootPath: workDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 10_000,
    });

    expect(result.files).toContain('src/a.ts');
    expect(result.files).not.toContain('state/gateway.heartbeat');
    expect(result.files).not.toContain('cron/ticker_1');
    expect(result.files).not.toContain('cron/.tick.lock');
  });
});

describe('FileExtractor skips hot churn (TRA-2021)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-churn-extract-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('skips a present heartbeat without parsing it as source', async () => {
    mkdirSync(join(tmpHome, 'state'), { recursive: true });
    writeFileSync(join(tmpHome, 'state', 'gateway.heartbeat'), '{"ts":1}\n');
    const ex = makeExtractor(tmpHome);

    const res = await ex.extract('state/gateway.heartbeat', false);

    expect(res.kind).toBe('skipped');
  });
});

describe('indexFiles on churn-only traffic is a no-op (TRA-2021)', () => {
  let tmpHome: string;
  let projDir: string;
  let db: Database.Database;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-churn-indexfiles-'));
    projDir = join(tmpHome, 'proj');
    mkdirSync(join(projDir, 'state'), { recursive: true });
    mkdirSync(join(projDir, 'cron'), { recursive: true });
    writeFileSync(join(projDir, 'state', 'gateway.heartbeat'), '{"ts":1}\n');
    db = initializeDatabase(join(tmpHome, 'index.db'));
    store = new Store(db);
    pipeline = new IndexingPipeline(
      store,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      projDir,
    );
  });

  afterEach(async () => {
    await pipeline.dispose?.();
    try {
      db.close();
    } catch {
      /* best-effort */
    }
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns zero work with no errors', async () => {
    const r = await pipeline.indexFiles([
      join(projDir, 'state', 'gateway.heartbeat'),
      join(projDir, 'cron', 'ticker_1'),
      join(projDir, 'cron', '.tick.lock'),
    ]);

    expect(r.totalFiles).toBe(0);
    expect(r.indexed).toBe(0);
    expect(r.errors).toBe(0);
  });
});

describe('FileWatcher drops hot-churn events (TRA-2021)', () => {
  let watcher: FileWatcher;
  let flush: () => Promise<void>;
  let setMock: ReturnType<typeof vi.fn>;
  let capturedCallback: (err: Error | null, events: parcelWatcher.Event[]) => Promise<void>;
  let tmpRoot: string;

  beforeEach(() => {
    let pendingFn: (() => void | Promise<void>) | null = null;
    setMock = vi.fn((fn: () => void | Promise<void>) => {
      pendingFn = fn;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearMock = vi.fn(() => {
      pendingFn = null;
    });
    flush = async () => {
      if (pendingFn) {
        const fn = pendingFn;
        pendingFn = null;
        await fn();
      }
    };
    watcher = new FileWatcher(
      setMock as unknown as typeof setTimeout,
      clearMock as unknown as typeof clearTimeout,
    );
    vi.mocked(parcelWatcher.subscribe).mockImplementation(async (_root, cb) => {
      capturedCallback = cb as typeof capturedCallback;
      return { unsubscribe: vi.fn().mockResolvedValue(undefined) };
    });
    tmpRoot = mkdtempSync(join(tmpdir(), 'trace-mcp-churn-watcher-'));
  });

  afterEach(async () => {
    await watcher.stop();
    vi.clearAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('forwards real edits while swallowing heartbeat/ticker churn', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start(
      tmpRoot,
      TraceMcpConfigSchema.parse({ root: tmpRoot, include: ['**/*'], exclude: [] }),
      onChanges,
    );

    await capturedCallback(null, [
      { type: 'update', path: join(tmpRoot, 'state', 'gateway.heartbeat') },
      { type: 'update', path: join(tmpRoot, 'cron', 'ticker_1') },
      { type: 'update', path: join(tmpRoot, 'cron', '.tick.lock') },
      { type: 'update', path: join(tmpRoot, 'src', 'app.ts') },
    ]);
    await flush();

    expect(onChanges).toHaveBeenCalledTimes(1);
    expect(onChanges).toHaveBeenCalledWith([join(tmpRoot, 'src', 'app.ts')]);
  });

  it('stays silent when every event is hot churn', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start(
      tmpRoot,
      TraceMcpConfigSchema.parse({ root: tmpRoot, include: ['**/*'], exclude: [] }),
      onChanges,
    );

    await capturedCallback(null, [
      { type: 'update', path: join(tmpRoot, 'state', 'gateway.heartbeat') },
    ]);
    await flush();

    expect(onChanges).not.toHaveBeenCalled();
  });
});

describe('handleReindexFile churn fast path (TRA-2021)', () => {
  const PROJECT = '/tmp/reindex-churn-proj';

  /** Must throw if called — the churn path answers before the lock. */
  const explodingLock = (async () => {
    throw new Error('lock must not be acquired for hot-churn paths');
  }) as typeof withLock;

  beforeEach(() => {
    __resetReindexStatsForTests();
  });

  afterEach(() => {
    __resetReindexStatsForTests();
  });

  it('answers skippedChurn without touching the lock or pipeline', async () => {
    const indexFiles = vi.fn(
      async (): Promise<IndexingResult> => ({
        totalFiles: 1,
        indexed: 1,
        skipped: 0,
        errors: 0,
        durationMs: 1,
      }),
    );
    const result = await handleReindexFile(
      { project: PROJECT, path: 'state/gateway.heartbeat' },
      {
        getProject: () => ({ pipeline: { indexFiles }, status: 'ready' as const }),
        lock: explodingLock,
      },
    );

    expect(result).toEqual({
      ok: true,
      relPath: 'state/gateway.heartbeat',
      skippedChurn: true,
    });
    expect(indexFiles).not.toHaveBeenCalled();
  });

  it('counts churn drops in fast_skipped_churn, not in hash/indexed buckets', async () => {
    const indexFiles = vi.fn(
      async (): Promise<IndexingResult> => ({
        totalFiles: 1,
        indexed: 1,
        skipped: 0,
        errors: 0,
        durationMs: 1,
      }),
    );
    const deps = {
      getProject: () => ({ pipeline: { indexFiles }, status: 'ready' as const }),
      lock: explodingLock,
    };
    await handleReindexFile({ project: PROJECT, path: 'cron/ticker_7' }, deps);

    const summary = getReindexStats().summarize();
    expect(summary.total).toBe(1);
    expect(summary.fast_skipped_churn).toBe(1);
    expect(summary.fast_skipped_recent).toBe(0);
    expect(summary.fast_skipped_hash).toBe(0);
    expect(summary.indexed).toBe(0);
  });
});

describe('renderDaemonEvents churn line (TRA-2021)', () => {
  const base = {
    total: 10,
    fast_skipped_recent: 1,
    fast_skipped_hash: 2,
    indexed: 7,
    p50_ms: 5,
    p95_ms: 9,
    p95_queued_ms: 12,
  };

  it('shows the churn line when non-zero', () => {
    const out = renderDaemonEvents({ ...base, fast_skipped_churn: 3 });
    expect(out).toMatch(/skipped_churn/);
    expect(out).toMatch(/3/);
  });

  it('renders unchanged when the counter is absent (older daemons)', () => {
    const out = renderDaemonEvents(base);
    expect(out).not.toMatch(/skipped_churn/);
    expect(out).toMatch(/skipped_hash/);
  });
});
