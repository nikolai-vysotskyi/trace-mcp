/**
 * TRA-2500: Browser runtime cache directories (Chromium Cache_Data, Code Cache,
 * GPUCache, Dawn/Graphite caches, Service Worker CacheStorage/ScriptCache,
 * Firefox cache2, etc.) inside project trees caused 13k+ watcher churn events,
 * ENOENT read errors when files vanished, and max_files truncation during full walks.
 *
 * Requirements:
 *  1. `isHotChurnPath` matches browser runtime cache paths across platforms.
 *  2. Real sources and assets with similar names (EditorChrome.php, ChromeCache.ts,
 *     Cache.php, src/cache/redis.ts, etc.) are never dropped.
 *  3. `collectFiles` drops browser cache directories from full walk, protecting security.max_files.
 *  4. `FileWatcher` drops browser cache events before debounce.
 *  5. `handleReindexFile` answers skippedChurn without acquiring lock.
 *  6. `indexFiles` on browser cache paths is a zero-work no-op.
 *  7. `FileExtractor` skips browser cache paths before disk read.
 *  8. `loadConfig` includes browser cache excludes in defaults and preserves them
 *     even when custom excludes override defaults (essentialExcludes).
 */
import * as parcelWatcher from '@parcel/watcher';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import picomatch from 'picomatch';
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

import { loadConfig, TraceMcpConfigSchema } from '../../config.js';
import { handleReindexFile } from '../../daemon/reindex-file-handler.js';
import { __resetReindexStatsForTests } from '../../daemon/reindex-stats.js';
import { initializeDatabase } from '../../db/schema.js';
import { Store } from '../../db/store.js';
import { PluginRegistry } from '../../plugin-api/registry.js';
import { HOT_CHURN_NATIVE_IGNORE_GLOBS, isHotChurnPath } from '../../utils/hot-churn.js';
import { collectFiles } from '../file-collector.js';
import { FileExtractor } from '../file-extractor.js';
import { IndexingPipeline } from '../pipeline.js';
import { buildProjectContext } from '../project-context.js';
import { FileWatcher } from '../watcher.js';

describe('TRA-2500: isHotChurnPath browser runtime caches', () => {
  it.each([
    // Chromium Cache_Data (exact evidence from daemon.log)
    'industry-map-top15/v32/ig/_chrome/Default/Cache/Cache_Data/67e61b96a0662fa9_0',
    'industry-map-top15/v32/ig/_chrome/Default/Cache/Cache_Data/index-dir/the-real-index',
    'Default/Cache/Cache_Data/data_0',
    'Cache/Cache_Data/f_000001',
    'Cache_Data/entry_0',
    // Chromium Code Cache (V8 bytecode & WebAssembly)
    'industry-map-top15/v32/ig/_chrome/Default/Code Cache/js/00a0c38f126ea7cd_0',
    'industry-map-top15/v32/ig/_chrome/Default/Code Cache/wasm/149c49aeb50869d2_0',
    '_chrome/Default/Code Cache/js/index',
    // Chromium GPU & WebGPU caches
    'industry-map-top15/v32/ig/_chrome/Default/GPUCache/data_0',
    'industry-map-top15/v32/ig/_chrome/GPUPersistentCache/GPUCache/4YWEKYZOTOBTKKPZK4HJJEJ3KCN6ZLRS',
    'industry-map-top15/v32/ig/_chrome/Default/DawnGraphiteCache/data_0',
    'industry-map-top15/v32/ig/_chrome/Default/DawnWebGPUCache/data_0',
    'industry-map-top15/v32/ig/_chrome/GraphiteDawnCache/data_0',
    'industry-map-top15/v32/ig/_chrome/Default/ShaderCache/data_0',
    'industry-map-top15/v32/ig/_chrome/Default/GrShaderCache/data_0',
    // Chromium Service Worker Cache
    'industry-map-top15/v32/ig/_chrome/Default/Service Worker/CacheStorage/2348e52d6de9218df880d9a88ad6a5d8c2c9555c/index',
    'industry-map-top15/v32/ig/_chrome/Default/Service Worker/ScriptCache/index-dir/the-real-index',
    // Firefox profile caches
    'firefox/profile/cache2/entries/12345678_0',
    'profile/cache2/doomed/123',
    'profile/startupCache/scriptLoader',
    'profile/jumpListCache/jump_0',
    // WebKit cache
    'Library/Caches/WebKit/WebKitCache/version',
    // Windows paths
    'C:\\proj\\industry-map-top15\\v32\\ig\\_chrome\\Default\\Cache\\Cache_Data\\67e61b96a0662fa9_0',
    'C:\\proj\\_chrome\\Default\\Code Cache\\js\\00a0c38f126ea7cd_0',
    // Case insensitivity
    '_CHROME/DEFAULT/CACHE/CACHE_DATA/123_0',
    '_CHROME/DEFAULT/CODE CACHE/JS/123_0',
  ])('matches browser runtime cache path: %s', (p) => {
    expect(isHotChurnPath(p)).toBe(true);
  });

  it.each([
    // Real sources from the project (including names with "Chrome" or "Cache")
    'fair/_square-thumbs/fair-laravel/nova-components/novakit/src/Fields/Top15TinyMce/EditorChrome.php',
    'top15/top15-l13/nova-components/novakit/src/Fields/Top15TinyMce/EditorChrome.php',
    'src/components/ChromeCache.ts',
    'app/Services/Cache.php',
    'src/cache/redis.ts',
    'app/cache/file_store.php',
    'src/views/cache_data_view.vue',
    'src/types/gpucache.d.ts',
    'src/models/ServiceWorker.ts',
    'docs/cache2-architecture.md',
    'src/index.ts',
    'app/Http/Controllers/UserController.php',
  ])('preserves real source and asset path: %s', (p) => {
    expect(isHotChurnPath(p)).toBe(false);
  });

  it('native ignore globs match browser cache directories', () => {
    const isIgnored = picomatch([...HOT_CHURN_NATIVE_IGNORE_GLOBS], { dot: true });
    expect(
      isIgnored('industry-map-top15/v32/ig/_chrome/Default/Cache/Cache_Data/67e61b96a0662fa9_0'),
    ).toBe(true);
    expect(
      isIgnored('industry-map-top15/v32/ig/_chrome/Default/Code Cache/js/00a0c38f126ea7cd_0'),
    ).toBe(true);
    expect(isIgnored('industry-map-top15/v32/ig/_chrome/Default/GPUCache/data_0')).toBe(true);
    expect(
      isIgnored(
        'fair/_square-thumbs/fair-laravel/nova-components/novakit/src/Fields/Top15TinyMce/EditorChrome.php',
      ),
    ).toBe(false);
    expect(isIgnored('src/components/ChromeCache.ts')).toBe(false);
    expect(isIgnored('src/cache/redis.ts')).toBe(false);
  });
});

describe('TRA-2500: Full walk (collectFiles) and security.max_files', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tra-2500-walk-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('excludes browser cache files from full walk and prevents max_files truncation', async () => {
    // 3 real source files
    const srcDir = join(tmpDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'index.ts'), 'export const a = 1;\n');
    writeFileSync(join(srcDir, 'EditorChrome.php'), '<?php class EditorChrome {}\n');
    writeFileSync(join(srcDir, 'ChromeCache.ts'), 'export const b = 2;\n');

    // 15 browser cache files (would exceed maxFiles=5 if not excluded)
    const cacheDataDir = join(tmpDir, '_chrome', 'Default', 'Cache', 'Cache_Data');
    mkdirSync(cacheDataDir, { recursive: true });
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(cacheDataDir, `entry_${i}.ts`), `// cache file ${i}`);
    }

    const codeCacheDir = join(tmpDir, '_chrome', 'Default', 'Code Cache', 'js');
    mkdirSync(codeCacheDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(codeCacheDir, `js_${i}.js`), `// code cache ${i}`);
    }

    const config = (await loadConfig(tmpDir))._unsafeUnwrap();
    const result = await collectFiles({
      config,
      rootPath: tmpDir,
      workspaces: [],
      traceignore: undefined,
      maxFiles: 5, // cap is 5; with 20 cache files + 3 real files = 23 total
    });

    // Cache files must not count towards max_files; 3 real files fit under cap of 5
    expect(result.truncated).toBe(false);
    expect(result.found).toBe(3);
    expect(result.files).toContain('src/index.ts');
    expect(result.files).toContain('src/EditorChrome.php');
    expect(result.files).toContain('src/ChromeCache.ts');
    expect(result.files.some((f) => f.includes('Cache_Data'))).toBe(false);
    expect(result.files.some((f) => f.includes('Code Cache'))).toBe(false);
  });
});

describe('TRA-2500: Watcher & reindex-file churn prevention', () => {
  let tmpDir: string;
  let db: Database.Database;
  let store: Store;
  let pipeline: IndexingPipeline;
  let watcher: FileWatcher;
  let flush: () => Promise<void>;
  let capturedCallback: (err: Error | null, events: parcelWatcher.Event[]) => Promise<void>;

  beforeEach(() => {
    __resetReindexStatsForTests();
    tmpDir = mkdtempSync(join(tmpdir(), 'tra-2500-churn-'));
    db = initializeDatabase(join(tmpDir, 'index.db'));
    store = new Store(db);
    pipeline = new IndexingPipeline(
      store,
      PluginRegistry.createWithDefaults(),
      TraceMcpConfigSchema.parse({}),
      tmpDir,
    );

    let pendingFn: (() => void | Promise<void>) | null = null;
    const setMock = vi.fn((fn: () => void | Promise<void>) => {
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
  });

  afterEach(async () => {
    await watcher.stop();
    await pipeline.dispose?.();
    try {
      db.close();
    } catch {
      /* best effort */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('FileWatcher drops browser cache events before debounce and forwards real edits', async () => {
    const onChanges = vi.fn().mockResolvedValue(undefined);
    const config = TraceMcpConfigSchema.parse({});

    await watcher.start(tmpDir, config, onChanges, 10);
    expect(capturedCallback).toBeDefined();

    // Fire browser cache churn events along with a real source edit
    await capturedCallback(null, [
      {
        type: 'create',
        path: join(tmpDir, '_chrome/Default/Cache/Cache_Data/67e61b96a0662fa9_0'),
      },
      {
        type: 'update',
        path: join(tmpDir, '_chrome/Default/Code Cache/js/00a0c38f126ea7cd_0'),
      },
      {
        type: 'create',
        path: join(tmpDir, '_chrome/Default/GPUCache/data_0'),
      },
      {
        type: 'create',
        path: join(tmpDir, 'src/EditorChrome.php'),
      },
    ]);

    await flush();

    expect(onChanges).toHaveBeenCalledTimes(1);
    const forwardedPaths = onChanges.mock.calls[0][0];
    expect(forwardedPaths).toEqual([join(tmpDir, 'src/EditorChrome.php')]);
    expect(forwardedPaths.some((p: string) => p.includes('Cache_Data'))).toBe(false);
  });

  it('handleReindexFile answers skippedChurn immediately for browser caches', async () => {
    const deps = {
      getProject: () => ({
        pipeline: { indexFiles: vi.fn().mockResolvedValue({ indexed: 0 }) },
        status: 'ready' as const,
      }),
    };

    const res = await handleReindexFile(
      {
        project: tmpDir,
        path: '_chrome/Default/Cache/Cache_Data/67e61b96a0662fa9_0',
      },
      deps,
    );

    expect(res).toEqual({
      ok: true,
      relPath: '_chrome/Default/Cache/Cache_Data/67e61b96a0662fa9_0',
      skippedChurn: true,
    });
  });

  it('indexFiles on browser cache path is a no-op returning zero work', async () => {
    const res = await pipeline.indexFiles([
      join(tmpDir, '_chrome/Default/Cache/Cache_Data/67e61b96a0662fa9_0'),
      join(tmpDir, '_chrome/Default/GPUCache/data_0'),
    ]);

    expect(res.indexed).toBe(0);
    expect(res.totalFiles).toBe(0);
    expect(res.errors).toBe(0);
  });

  it('FileExtractor skips browser cache paths before reading disk', async () => {
    const extractor = new FileExtractor({
      registry: PluginRegistry.createWithDefaults(),
      rootPath: tmpDir,
      workspaces: [],
      gitignore: undefined,
      fileContentCache: new Map(),
      buildProjectContext: () => buildProjectContext(tmpDir),
      existingFiles: new Map(),
    });

    const res = await extractor.extract('_chrome/Default/Cache/Cache_Data/vanished_file_0', false);

    // Skipped cleanly without attempting fs.readFileSync (which would throw ENOENT)
    expect(res.kind).toBe('skipped');
  });
});

describe('TRA-2500: Config defaults and essential excludes override protection', () => {
  it('loadConfig includes browser cache excludes even when user config overrides excludes', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tra-2500-cfg-'));
    try {
      // Simulate general project: user config specifies custom exclude array that omits browser caches
      writeFileSync(
        join(tmp, '.trace-mcp.json'),
        JSON.stringify({
          exclude: ['vendor/**', 'node_modules/**'],
        }),
      );

      const cfg = (await loadConfig(tmp))._unsafeUnwrap();
      expect(cfg.exclude).toContain('**/Cache_Data/**');
      expect(cfg.exclude).toContain('**/Code Cache/**');
      expect(cfg.exclude).toContain('**/GPUCache/**');
      expect(cfg.exclude).toContain('**/cache2/**');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
