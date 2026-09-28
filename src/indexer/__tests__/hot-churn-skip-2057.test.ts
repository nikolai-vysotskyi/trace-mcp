/**
 * TRA-2057: atomic tmp sibling of `cache/reasoning_caps.json` raced the
 * watcher — hermes rewrites the caps file via
 * `cache/.reasoning_caps_<rand>.tmp` + rename and the watcher caught the
 * tmp between create and rename (4× `Cannot read file ENOENT` already on
 * a daemon with the TRA-2031 fix; the TRA-2031 matcher covered only the
 * `.hb_` / `.gateway_` prefixes under `cron`/`state`, never this prefix
 * or the `cache/` segment).
 *
 * Same "engine scratch, never source" argument, same narrowed treatment
 * (exact dot-tmp prefix + a whole `cache` path segment), same entry
 * points as TRA-2031:
 *
 *  1. `isHotChurnPath` matches `.reasoning_caps_*.tmp` only under a whole
 *     `cache` segment (a bare `*.tmp` — or any other dot-tmp — under
 *     `cache/` is a real user source, e.g. `src/cache/.env.tmp`;
 *     `caches/`-style substring dirs never match).
 *  2. `collectFiles` (full walk) never lists them (second layer behind
 *     fast-glob `dot: false`).
 *  3. `FileWatcher` drops tmp-sibling events before debounce, so they
 *     never wake the pipeline at all.
 *  4. `handleReindexFile` (HTTP hook path) answers `skippedChurn`
 *     before `withLock`.
 *  5. `indexFiles` on a tmp sibling is a zero-work no-op with no errors.
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

describe('isHotChurnPath reasoning_caps tmp sibling (TRA-2057)', () => {
  it.each([
    // Exact evidence shapes from the night QA run.
    'cache/.reasoning_caps_x9095vef.tmp',
    'cache/.reasoning_caps_tjw8eypo.tmp',
    'cache/.reasoning_caps_gj1npvpb.tmp',
    '.hermes/cache/.reasoning_caps_abc123.tmp',
    // Nested deeper under a churn segment — still engine scratch.
    'cache/nested/.reasoning_caps_deep.tmp',
    // Absolute / Windows / case variants.
    'C:\\proj\\cache\\.reasoning_caps_x.tmp',
    'CACHE/.REASONING_CAPS_UPPER.TMP',
  ])('matches tmp sibling %s', (p) => {
    expect(isHotChurnPath(p)).toBe(true);
  });

  it.each([
    'src/a.ts',
    // A bare `*.tmp` is a real user source — only dot-tmp drops.
    'cache/notes.tmp',
    'src/draft.tmp',
    // Dot-tmp with any other prefix is a real user source too — the
    // predicate only covers the observed `.reasoning_caps_` sibling.
    'cache/.random.tmp',
    'cache/.session.tmp',
    'src/cache/.env.tmp',
    'app/cache/.session.tmp',
    // Dot-tmp outside a whole `cache` segment is not churn.
    'src/.reasoning_caps_x.tmp',
    '.hermes/.reasoning_caps_orphan.tmp',
    // Substring dirs must not match: `caches` is not `cache`.
    'caches/.reasoning_caps_x.tmp',
    'mycache/.reasoning_caps_x.tmp',
    // Dotfiles without the `.tmp` suffix / with a trailing suffix stay —
    // note the live `cache/reasoning_caps.json` itself still indexes.
    'cache/reasoning_caps.json',
    'cache/.reasoning_caps_backup',
    'cache/.reasoning_caps_x.tmp.bak',
  ])('does not match %s', (p) => {
    expect(isHotChurnPath(p)).toBe(false);
  });

  it.each([
    // TRA-2031 shapes keep matching after the predicate restructure.
    'cron/.hb_yj5dpdzi.tmp',
    'state/.gateway_pxlzyju_.tmp',
    'cron/notes.tmp',
    'state/.session.tmp',
    'cronjobs/.hb_x.tmp',
  ])('TRA-2031 behaviour unchanged for %s', (p) => {
    expect(isHotChurnPath(p)).toBe(
      p === 'cron/.hb_yj5dpdzi.tmp' || p === 'state/.gateway_pxlzyju_.tmp',
    );
  });
});

describe('collectFiles drops reasoning_caps tmp siblings (TRA-2057)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'trace-mcp-churn2057-collect-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('lists sources but never atomic tmp siblings', async () => {
    // First layer is fast-glob `dot: false` (dotfiles never listed); the
    // `isHotChurnPath` filter asserted here is the second layer.
    mkdirSync(join(workDir, 'cache'), { recursive: true });
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'cache', '.reasoning_caps_abc.tmp'), '{"ts":1}\n');
    // A bare `*.tmp` source under `cache` must survive the filter.
    writeFileSync(join(workDir, 'cache', 'notes.tmp'), 'user notes\n');
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
    expect(result.files).toContain('cache/notes.tmp');
    expect(result.files).not.toContain('cache/.reasoning_caps_abc.tmp');
  });
});

describe('FileWatcher drops reasoning_caps tmp-sibling events (TRA-2057)', () => {
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
    tmpRoot = mkdtempSync(join(tmpdir(), 'trace-mcp-churn2057-watcher-'));
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
      { type: 'update', path: join(tmpRoot, 'cache', '.reasoning_caps_x9095vef.tmp') },
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
      { type: 'update', path: join(tmpRoot, 'cache', '.reasoning_caps_tjw8eypo.tmp') },
    ]);
    await flush();

    expect(onChanges).not.toHaveBeenCalled();
  });
});

describe('handleReindexFile reasoning_caps tmp-sibling fast path (TRA-2057)', () => {
  const PROJECT = '/tmp/reindex-churn2057-proj';

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
      { project: PROJECT, path: 'cache/.reasoning_caps_x9095vef.tmp' },
      {
        getProject: () => ({ pipeline: { indexFiles }, status: 'ready' as const }),
        lock: explodingLock,
      },
    );

    expect(result).toEqual({
      ok: true,
      relPath: 'cache/.reasoning_caps_x9095vef.tmp',
      skippedChurn: true,
    });
    expect(indexFiles).not.toHaveBeenCalled();
  });
});

describe('indexFiles on reasoning_caps tmp sibling is a no-op (TRA-2057)', () => {
  let tmpHome: string;
  let projDir: string;
  let db: Database.Database;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-churn2057-indexfiles-'));
    projDir = join(tmpHome, 'proj');
    mkdirSync(join(projDir, 'cache'), { recursive: true });
    writeFileSync(join(projDir, 'cache', '.reasoning_caps_abc.tmp'), '{"ts":1}\n');
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
    const r = await pipeline.indexFiles([join(projDir, 'cache', '.reasoning_caps_abc.tmp')]);

    expect(r.totalFiles).toBe(0);
    expect(r.indexed).toBe(0);
    expect(r.errors).toBe(0);
  });
});
