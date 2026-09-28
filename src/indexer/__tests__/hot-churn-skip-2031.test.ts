/**
 * TRA-2031: atomic tmp siblings of hot-churn runtime state
 * (`cron/.hb_*.tmp`, `state/.gateway_*.tmp`) raced the watcher — hermes
 * writes heartbeat/ticker state via tmp + rename and the watcher caught
 * the tmp between create and rename (10× `Cannot read file ENOENT` on a
 * live daemon, same storm traffic as TRA-2021's 48–62 s lock-queue
 * elapsed). The TRA-2021 matcher (`gateway.heartbeat`, `ticker_*`,
 * `.tick.lock`) never covered these tmp basenames.
 *
 * Same "engine scratch, never source" argument: every indexing entry
 * point drops them before any stat/read/lock —
 *
 *  1. `isHotChurnPath` matches the observed `.hb_` / `.gateway_`
 *     dot-tmp prefixes only, under a whole `cron`/`state` path segment
 *     (a bare `*.tmp` — or any other dot-tmp — under `state/` is a real
 *     user source far too often, e.g. `src/state/.env.tmp`;
 *     `cronjobs/`-style substring dirs never match).
 *  2. `collectFiles` (full walk) never lists them — belt-and-braces:
 *     fast-glob runs with `dot: false`, so dotfiles are already excluded
 *     before the filter; the filter covers a future `dot: true` walk.
 *  3. `FileWatcher` drops tmp-sibling events before debounce, so they
 *     never wake the pipeline at all.
 *  4. `handleReindexFile` (HTTP hook path) answers `skippedChurn`
 *     before `withLock`.
 *  5. Bare `cron`/`state` directory events stay dropped by the TRA-1649
 *     isDirectory guard in `filterIndexablePaths` — exercised below via
 *     `indexFiles` (which calls it pre-lock), proving a `cron` mkdir
 *     event is a zero-work no-op, not a lock queue entry.
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

import { TraceMcpConfigSchema } from '../../config.js';
import { handleReindexFile } from '../../daemon/reindex-file-handler.js';
import { __resetReindexStatsForTests } from '../../daemon/reindex-stats.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import type { withLock } from '../../utils/pid-lock.js';
import { isHotChurnPath } from '../../utils/hot-churn.js';
import { collectFiles } from '../file-collector.js';
import { IndexingPipeline } from '../pipeline.js';
import { FileWatcher } from '../watcher.js';

describe('isHotChurnPath tmp siblings (TRA-2031)', () => {
  it.each([
    // Exact evidence shapes from the night QA run.
    'cron/.hb_yj5dpdzi.tmp',
    'cron/.hb_90d_sfiy.tmp',
    'state/.gateway_pxlzyju_.tmp',
    'state/.gateway_ph23r0lb.tmp',
    '.hermes/cron/.hb_thcdxhei.tmp',
    '.hermes/state/.gateway_7sgevowm.tmp',
    // Nested deeper under a churn segment — still engine scratch.
    'state/nested/.gateway_deep.tmp',
    // Absolute / Windows / case variants.
    'C:\\proj\\cron\\.hb_14neowdp.tmp',
    'C:\\proj\\state\\.gateway_x.tmp',
    'CRON/.HB_UPPER.TMP',
  ])('matches tmp sibling %s', (p) => {
    expect(isHotChurnPath(p)).toBe(true);
  });

  it.each([
    'src/a.ts',
    // A bare `*.tmp` is a real user source — only dot-tmp drops.
    'cron/notes.tmp',
    'state/cache.tmp',
    'src/draft.tmp',
    // Dot-tmp with any other prefix is a real user source too — the
    // predicate only covers the observed `.hb_` / `.gateway_` siblings.
    'cron/.random.tmp',
    'state/.session.tmp',
    'src/state/.env.tmp',
    'app/state/.session.tmp',
    // Dot-tmp outside a whole `cron`/`state` segment is not churn.
    'src/.hb_x.tmp',
    'src/.gateway_y.tmp',
    '.hermes/.hb_orphan.tmp',
    // Substring dirs must not match: `cronjobs` is not `cron`.
    'cronjobs/.hb_x.tmp',
    'mycron/.hb_x.tmp',
    'mystate/.gateway_x.tmp',
    // Dotfiles without the `.tmp` suffix / with a trailing suffix stay.
    'state/.gateway_heartbeat',
    'cron/.hb_x.tmp.bak',
    'heartbeat.md',
  ])('does not match %s', (p) => {
    expect(isHotChurnPath(p)).toBe(false);
  });
});

describe('collectFiles drops tmp siblings (TRA-2031)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'trace-mcp-churn-tmp-collect-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('lists sources but never atomic tmp siblings', async () => {
    // First layer is fast-glob `dot: false` (dotfiles never listed); the
    // `isHotChurnPath` filter asserted here is the second layer.
    mkdirSync(join(workDir, 'state'), { recursive: true });
    mkdirSync(join(workDir, 'cron'), { recursive: true });
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'state', '.gateway_abc.tmp'), '{"ts":1}\n');
    writeFileSync(join(workDir, 'cron', '.hb_xyz.tmp'), 'tick\n');
    // A bare `*.tmp` source under `cron` must survive the filter.
    writeFileSync(join(workDir, 'cron', 'notes.tmp'), 'user notes\n');
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
    expect(result.files).toContain('cron/notes.tmp');
    expect(result.files).not.toContain('state/.gateway_abc.tmp');
    expect(result.files).not.toContain('cron/.hb_xyz.tmp');
  });
});

describe('FileWatcher drops tmp-sibling events (TRA-2031)', () => {
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
    tmpRoot = mkdtempSync(join(tmpdir(), 'trace-mcp-churn-tmp-watcher-'));
  });

  afterEach(async () => {
    await watcher.stop();
    vi.clearAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('forwards real edits while swallowing tmp-sibling churn', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start(
      tmpRoot,
      TraceMcpConfigSchema.parse({ root: tmpRoot, include: ['**/*'], exclude: [] }),
      onChanges,
    );

    await capturedCallback(null, [
      { type: 'update', path: join(tmpRoot, 'cron', '.hb_yj5dpdzi.tmp') },
      { type: 'update', path: join(tmpRoot, 'state', '.gateway_pxlzyju_.tmp') },
      { type: 'update', path: join(tmpRoot, 'src', 'app.ts') },
    ]);
    await flush();

    expect(onChanges).toHaveBeenCalledTimes(1);
    expect(onChanges).toHaveBeenCalledWith([join(tmpRoot, 'src', 'app.ts')]);
  });

  it('stays silent when every event is a tmp sibling', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start(
      tmpRoot,
      TraceMcpConfigSchema.parse({ root: tmpRoot, include: ['**/*'], exclude: [] }),
      onChanges,
    );

    await capturedCallback(null, [
      { type: 'update', path: join(tmpRoot, 'cron', '.hb_90d_sfiy.tmp') },
    ]);
    await flush();

    expect(onChanges).not.toHaveBeenCalled();
  });
});

describe('handleReindexFile tmp-sibling fast path (TRA-2031)', () => {
  const PROJECT = '/tmp/reindex-churn-tmp-proj';

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
    const indexFiles = vi.fn(async () => ({
      totalFiles: 1,
      indexed: 1,
      skipped: 0,
      errors: 0,
      durationMs: 1,
    }));
    const result = await handleReindexFile(
      { project: PROJECT, path: 'cron/.hb_yj5dpdzi.tmp' },
      {
        getProject: () => ({ pipeline: { indexFiles }, status: 'ready' as const }),
        lock: explodingLock,
      },
    );

    expect(result).toEqual({
      ok: true,
      relPath: 'cron/.hb_yj5dpdzi.tmp',
      skippedChurn: true,
    });
    expect(indexFiles).not.toHaveBeenCalled();
  });
});

describe('indexFiles on tmp siblings + bare churn dirs is a no-op (TRA-2031)', () => {
  let tmpHome: string;
  let projDir: string;
  let db: Database.Database;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-churn-tmp-indexfiles-'));
    projDir = join(tmpHome, 'proj');
    mkdirSync(join(projDir, 'state'), { recursive: true });
    mkdirSync(join(projDir, 'cron'), { recursive: true });
    writeFileSync(join(projDir, 'state', '.gateway_abc.tmp'), '{"ts":1}\n');
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
      join(projDir, 'state', '.gateway_abc.tmp'),
      join(projDir, 'cron', '.hb_xyz.tmp'),
      // Bare directory events (TRA-1649 guard) — never lock, never count.
      join(projDir, 'cron'),
      join(projDir, 'state'),
    ]);

    expect(r.totalFiles).toBe(0);
    expect(r.indexed).toBe(0);
    expect(r.errors).toBe(0);
  });
});
