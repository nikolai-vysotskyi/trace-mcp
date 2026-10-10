/**
 * TRA-2326: ML checkpoint tmp sibling (`resume_mlx.npz.tmp`, `enc.onnx.data.tmp`)
 * raced the watcher — ML training pipelines write checkpoints via `<name>.tmp`
 * and atomically replace them via rename. The watcher caught the tmp between
 * create and rename (199+ `Cannot read file ENOENT` in daemon.log).
 *
 * Same "engine scratch / intermediate artifact, never source" treatment as
 * TRA-2031 and TRA-2057:
 *  1. `isHotChurnPath` matches ML checkpoint `.npz.tmp` and `.onnx.data.tmp`
 *     only under a whole `artifacts` or `checkpoints` directory segment.
 *  2. General source files (even `.tmp` outside these directories, or non-ML files)
 *     are never dropped.
 *  3. `collectFiles` drops ML checkpoint tmp siblings.
 *  4. `FileWatcher` drops ML checkpoint tmp sibling events before debounce.
 *  5. `handleReindexFile` answers `skippedChurn` before `withLock`.
 *  6. `indexFiles` on an ML checkpoint tmp sibling is a zero-work no-op.
 *  7. `FileExtractor` rate limits repeated identical ENOENT warnings for disappearing
 *     files, suppressing repetitive log noise while preserving non-ENOENT warnings.
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
import { logger } from '../../logger.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { isHotChurnPath } from '../../utils/hot-churn.js';
import type { withLock } from '../../utils/pid-lock.js';
import { collectFiles } from '../file-collector.js';
import { FileExtractor, resetCannotReadEnoentDedupForTests } from '../file-extractor.js';
import { IndexingPipeline } from '../pipeline.js';
import { buildProjectContext } from '../project-context.js';
import { FileWatcher } from '../watcher.js';

describe('isHotChurnPath ML checkpoint tmp siblings (TRA-2326)', () => {
  it.each([
    // Exact evidence shapes from daemon.log in TRA-2326
    'classifier-mlx-backbones/src/classifier/taxonomy_v1/artifacts/finetune_lora_pplx-embed-v2-late-0.6b__cold_pplx/resume_mlx.npz.tmp',
    'classifier-mlx-backbones/src/classifier/taxonomy_v1/artifacts/finetune_lora_pplx-embed-v2-late-0.6b__pplx_qat8_ep3/resume_mlx.npz.tmp',
    'artifacts/resume_mlx.npz.tmp',
    'models/checkpoints/ep1/model.npz.tmp',
    'scratchpad/eg2-serve/exp/pplx_f16fuse_b64_mac_pp/artifacts/enc.onnx.data.tmp',
    'checkpoints/enc.onnx.data.tmp',
    // Windows and case variants
    'C:\\proj\\artifacts\\resume_mlx.npz.tmp',
    'ARTIFACTS\\RESUME_MLX.NPZ.TMP',
  ])('matches ML checkpoint tmp sibling %s', (p) => {
    expect(isHotChurnPath(p)).toBe(true);
  });

  it.each([
    // Real source files and non-ML tmp files
    'src/a.ts',
    'src/models/resume_mlx.npz.tmp', // not under artifacts or checkpoints
    'src/index.tmp',
    'artifacts/notes.txt',
    'artifacts/model.npz', // target checkpoint itself is NOT hot-churn
    'checkpoints/model.onnx',
    'src/artifacts.ts',
    'my_artifacts/resume_mlx.npz.tmp', // substring, not exact segment
    'checkpoint_store/resume_mlx.npz.tmp',
    'artifacts/draft.tmp', // bare .tmp without .npz or .onnx.data is preserved
  ])('does not match non-churn or user source %s', (p) => {
    expect(isHotChurnPath(p)).toBe(false);
  });
});

describe('collectFiles drops ML checkpoint tmp siblings (TRA-2326)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'trace-mcp-churn2326-collect-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('lists real sources but drops ML checkpoint tmp siblings', async () => {
    mkdirSync(join(workDir, 'artifacts', 'run1'), { recursive: true });
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'artifacts', 'run1', 'resume_mlx.npz.tmp'), 'binary data\n');
    writeFileSync(join(workDir, 'artifacts', 'notes.txt'), 'notes\n');
    writeFileSync(join(workDir, 'src', 'app.ts'), 'export const ready = true;\n');

    const config = TraceMcpConfigSchema.parse({ include: ['**/*'], exclude: [] });
    const result = await collectFiles({
      config,
      rootPath: workDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 10_000,
    });

    expect(result.files).toContain('src/app.ts');
    expect(result.files).toContain('artifacts/notes.txt');
    expect(result.files).not.toContain('artifacts/run1/resume_mlx.npz.tmp');
  });
});

describe('FileWatcher drops ML checkpoint tmp events (TRA-2326)', () => {
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
    tmpRoot = mkdtempSync(join(tmpdir(), 'trace-mcp-churn2326-watcher-'));
  });

  afterEach(async () => {
    await watcher.stop();
    vi.clearAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('forwards real changes and ignores ML checkpoint tmp events', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    await watcher.start(
      tmpRoot,
      TraceMcpConfigSchema.parse({ root: tmpRoot, include: ['**/*'], exclude: [] }),
      onChanges,
    );

    await capturedCallback(null, [
      { type: 'update', path: join(tmpRoot, 'artifacts', 'resume_mlx.npz.tmp') },
      { type: 'update', path: join(tmpRoot, 'src', 'main.ts') },
    ]);
    await flush();

    expect(onChanges).toHaveBeenCalledTimes(1);
    expect(onChanges).toHaveBeenCalledWith([join(tmpRoot, 'src', 'main.ts')]);
  });
});

describe('handleReindexFile ML checkpoint tmp sibling fast path (TRA-2326)', () => {
  const PROJECT = '/tmp/reindex-churn2326-proj';
  const explodingLock = (async () => {
    throw new Error('lock must not be acquired for hot-churn paths');
  }) as typeof withLock;

  beforeEach(() => {
    __resetReindexStatsForTests();
  });

  afterEach(() => {
    __resetReindexStatsForTests();
  });

  it('answers skippedChurn without acquiring lock', async () => {
    const indexFiles = vi.fn(async () => ({
      totalFiles: 1,
      indexed: 1,
      skipped: 0,
      errors: 0,
      durationMs: 1,
    }));
    const result = await handleReindexFile(
      { project: PROJECT, path: 'artifacts/run/resume_mlx.npz.tmp' },
      {
        getProject: () => ({ pipeline: { indexFiles }, status: 'ready' as const }),
        lock: explodingLock,
      },
    );

    expect(result).toEqual({
      ok: true,
      relPath: 'artifacts/run/resume_mlx.npz.tmp',
      skippedChurn: true,
    });
    expect(indexFiles).not.toHaveBeenCalled();
  });
});

describe('indexFiles on ML checkpoint tmp sibling is a no-op (TRA-2326)', () => {
  let tmpHome: string;
  let projDir: string;
  let db: Database.Database;
  let store: Store;
  let pipeline: IndexingPipeline;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'trace-mcp-churn2326-indexfiles-'));
    projDir = join(tmpHome, 'proj');
    mkdirSync(join(projDir, 'artifacts', 'model'), { recursive: true });
    writeFileSync(join(projDir, 'artifacts', 'model', 'resume_mlx.npz.tmp'), 'npz data\n');
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

  it('returns zero work with zero errors', async () => {
    const r = await pipeline.indexFiles([
      join(projDir, 'artifacts', 'model', 'resume_mlx.npz.tmp'),
    ]);

    expect(r.totalFiles).toBe(0);
    expect(r.indexed).toBe(0);
    expect(r.errors).toBe(0);
  });
});

describe('FileExtractor rate limits repeated identical ENOENTs (TRA-2326)', () => {
  let tmpRoot: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetCannotReadEnoentDedupForTests();
    tmpRoot = mkdtempSync(join(tmpdir(), 'trace-mcp-churn2326-extractor-'));
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCannotReadEnoentDedupForTests();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeExtractor(): FileExtractor {
    return new FileExtractor({
      registry: PluginRegistry.createWithDefaults(),
      rootPath: tmpRoot,
      workspaces: [],
      gitignore: undefined,
      fileContentCache: new Map(),
      buildProjectContext: () => buildProjectContext(tmpRoot),
      existingFiles: new Map(),
    });
  }

  it('first ENOENT logs warn, repeats go to debug, 50th emits warn summary', async () => {
    const extractor = makeExtractor();
    const target = 'volatile/scratch.tmp';

    for (let i = 0; i < 55; i++) {
      const res = await extractor.extract(target, false);
      expect(res.kind).toBe('error');
    }

    // 1 initial warn + 1 summary warn on 50th = 2 warns total
    expect(warnSpy).toHaveBeenCalledTimes(2);

    const firstCall = warnSpy.mock.calls[0];
    expect(firstCall[0]).toMatchObject({
      file: target,
      rootPath: tmpRoot,
      code: 'ENOENT',
    });
    expect(firstCall[1]).toBe('Cannot read file');

    const summaryCall = warnSpy.mock.calls[1];
    expect(summaryCall[0]).toMatchObject({
      file: target,
      rootPath: tmpRoot,
      code: 'ENOENT',
      repeatCount: 50,
    });
    expect(String(summaryCall[1])).toContain('Cannot read file 50 times with ENOENT');

    // 53 debug calls for suppressed repeats
    expect(debugSpy).toHaveBeenCalledTimes(53);
    const debugCall = debugSpy.mock.calls[0];
    expect(debugCall[0]).toMatchObject({
      file: target,
      rootPath: tmpRoot,
      code: 'ENOENT',
    });
    expect(debugCall[1]).toBe('Cannot read file (repeat suppressed)');
  });

  it('different ENOENT files log warns independently', async () => {
    const extractor = makeExtractor();
    await extractor.extract('file1.tmp', false);
    await extractor.extract('file2.tmp', false);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toMatchObject({ file: 'file1.tmp' });
    expect(warnSpy.mock.calls[1][0]).toMatchObject({ file: 'file2.tmp' });
  });
});
