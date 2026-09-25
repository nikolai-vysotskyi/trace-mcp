/**
 * TRA-1943: a live daemon spammed `Cannot read file` ENOENT for SQLite
 * sidecars (`kanban.db-wal` 59× + `kanban.db-shm` 39× in one 18h window) —
 * the watcher raced the engine's checkpoint unlink between readdir and open.
 * Sidecars are engine scratch, never source, so every indexing entry point
 * drops them before any stat/read:
 *
 *  1. `isSqliteSidecarPath` matches the live sidecar spellings and nothing
 *     else (no false positives on `interval`-style names or files nested
 *     under a `*-wal`-suffixed directory).
 *  2. `collectFiles` (full walk) never lists them.
 *  3. `FileExtractor` skips them pre-stat — and a sidecar that still races
 *     through to the read (stale event) logs at debug, not warn, and counts
 *     as `skipped`, not `error`.
 *  4. `indexFiles` on sidecar-only watcher churn is a zero-work no-op.
 *  5. `FileWatcher` drops sidecar events before debounce, so they never
 *     wake the pipeline at all.
 */
import * as parcelWatcher from '@parcel/watcher';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceMcpConfigSchema } from '../../config.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { logger } from '../../logger.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { isSqliteSidecarPath } from '../../utils/db-family.js';
import { collectFiles } from '../file-collector.js';
import { FileExtractor } from '../file-extractor.js';
import { IndexingPipeline } from '../pipeline.js';
import { buildProjectContext } from '../project-context.js';
import { FileWatcher } from '../watcher.js';

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn(),
}));

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

describe('isSqliteSidecarPath (TRA-1943)', () => {
  it.each([
    '.hermes/kanban.db-wal',
    '.hermes/kanban.db-shm',
    'kanban.db-journal',
    'data/app.sqlite-wal',
    'data/app.sqlite-shm',
    'C:\\proj\\.hermes\\kanban.db-wal',
  ])('matches live sidecar %s', (p) => {
    expect(isSqliteSidecarPath(p)).toBe(true);
  });

  it.each([
    '.hermes/kanban.db',
    'src/a.ts',
    // Ends in "wal" but with no dash — not a sidecar.
    'src/interval.ts',
    'docs/renewal.md',
    // A directory ending in -wal must not nuke the real files inside it.
    'backups/nightly-wal/report.ts',
    'kanban.db.watcher-snapshot',
  ])('does not match %s', (p) => {
    expect(isSqliteSidecarPath(p)).toBe(false);
  });
});

describe('collectFiles drops SQLite sidecars (TRA-1943)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'trace-mcp-sidecar-collect-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('lists the DB and sources but never its -wal/-shm companions', async () => {
    // Mirrors the incident shape: the live DB sits at the project root
    // (root-level names, not dot dirs — fast-glob `dot: false` already
    // skips dot-directories, so the filter must cover root-level churn).
    writeFileSync(join(workDir, 'kanban.db'), 'db-bytes');
    writeFileSync(join(workDir, 'kanban.db-wal'), 'wal-bytes');
    writeFileSync(join(workDir, 'kanban.db-shm'), 'shm-bytes');
    writeFileSync(join(workDir, 'kanban.db-journal'), 'journal-bytes');
    mkdirSync(join(workDir, 'src'), { recursive: true });
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
    expect(result.files).toContain('kanban.db');
    expect(result.files).not.toContain('kanban.db-wal');
    expect(result.files).not.toContain('kanban.db-shm');
    expect(result.files).not.toContain('kanban.db-journal');
  });
});

describe('FileExtractor skips SQLite sidecars (TRA-1943)', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-sidecar-extract-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('skips a vanished sidecar at debug with no Cannot-read warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
    const ex = makeExtractor(tmpHome);

    // Never created on disk — the checkpoint unlink already won the race.
    const res = await ex.extract('.hermes/kanban.db-wal', false);

    expect(res.kind).toBe('skipped');
    expect(warnSpy.mock.calls.filter(([, msg]) => msg === 'Cannot read file')).toHaveLength(0);
    expect(debugSpy.mock.calls.some(([, msg]) => String(msg).includes('sidecar'))).toBe(true);
  });

  it('skips even a present sidecar without reading it as source', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    mkdirSync(join(tmpHome, '.hermes'), { recursive: true });
    writeFileSync(join(tmpHome, '.hermes', 'kanban.db-shm'), 'shm-bytes');
    const ex = makeExtractor(tmpHome);

    const res = await ex.extract('.hermes/kanban.db-shm', false);

    expect(res.kind).toBe('skipped');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('still warns Cannot read file for a vanished non-sidecar (no over-suppression)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const ex = makeExtractor(tmpHome);

    const res = await ex.extract('src/gone.ts', false);

    expect(res.kind).toBe('error');
    expect(warnSpy.mock.calls.some(([, msg]) => msg === 'Cannot read file')).toBe(true);
  });
});

describe('indexFiles on sidecar-only churn is a no-op (TRA-1943)', () => {
  let tmpHome: string;
  let projDir: string;
  let db: Database.Database;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-sidecar-indexfiles-'));
    projDir = join(tmpHome, 'proj');
    mkdirSync(join(projDir, '.hermes'), { recursive: true });
    writeFileSync(join(projDir, '.hermes', 'kanban.db'), 'db-bytes');
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

  it('returns zero work with no errors and no warns', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const r = await pipeline.indexFiles([
      join(projDir, '.hermes', 'kanban.db-wal'),
      join(projDir, '.hermes', 'kanban.db-shm'),
    ]);

    expect(r.totalFiles).toBe(0);
    expect(r.errors).toBe(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('FileWatcher drops SQLite sidecar events (TRA-1943)', () => {
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
    tmpRoot = mkdtempSync(join(tmpdir(), 'trace-mcp-sidecar-watcher-'));
  });

  afterEach(async () => {
    await watcher.stop();
    vi.clearAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('never forwards -wal/-shm churn to onChanges', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start(
      tmpRoot,
      TraceMcpConfigSchema.parse({ root: tmpRoot, include: ['**/*'], exclude: [] }),
      onChanges,
    );

    await capturedCallback(null, [
      { type: 'update', path: join(tmpRoot, '.hermes', 'kanban.db-wal') },
      { type: 'create', path: join(tmpRoot, '.hermes', 'kanban.db-shm') },
      { type: 'update', path: join(tmpRoot, 'src', 'app.ts') },
    ]);
    await flush();

    expect(onChanges).toHaveBeenCalledTimes(1);
    expect(onChanges).toHaveBeenCalledWith([join(tmpRoot, 'src', 'app.ts')]);
  });

  it('stays silent when every event is sidecar churn', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start(
      tmpRoot,
      TraceMcpConfigSchema.parse({ root: tmpRoot, include: ['**/*'], exclude: [] }),
      onChanges,
    );

    await capturedCallback(null, [
      { type: 'update', path: join(tmpRoot, '.hermes', 'kanban.db-wal') },
    ]);
    await flush();

    expect(onChanges).not.toHaveBeenCalled();
  });
});
