/**
 * TRA-2524: Regression tests for event loop stall preventions during bulk
 * indexing and concurrent short reindexing on large repositories (e.g. 10k+ files,
 * 100+ workspaces, tens of thousands of heritage and member_of edges).
 *
 * Verifies:
 * 1. selectChangedFilesAsync yields to the event loop every 256 files so stat
 *    prefiltering does not block health checks.
 * 2. detectRenamesAsync yields to the event loop and fast-paths when the store is empty.
 * 3. EdgeResolver skips workspaces that have 0 indexed files in the DB and
 *    memoizes scopedCtx.getAllFiles().
 * 4. resolveTypeScriptHeritageEdges and resolveMemberOfEdges commit in chunks
 *    with fair event-loop yields between chunks.
 * 5. Integration plugins (Vue, Nuxt, Filament, Tailwind, Shadcn) cooperatively
 *    yield during resolveEdges.
 * 6. Health check responsiveness: event-loop latency stays bounded (<250ms)
 *    during heavy processing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { ok } from '../../src/errors.js';
import { selectChangedFilesAsync } from '../../src/indexer/change-prefilter.js';
import { detectRenamesAsync } from '../../src/indexer/rename-detector.js';
import { EdgeResolver } from '../../src/indexer/edge-resolver.js';
import { resolveTypeScriptHeritageEdges } from '../../src/indexer/edge-resolvers/heritage.js';
import { resolveMemberOfEdges } from '../../src/indexer/edge-resolvers/member-of.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { NuxtPlugin } from '../../src/indexer/plugins/integration/framework/nuxt/index.js';
import { TailwindPlugin } from '../../src/indexer/plugins/integration/view/tailwind/index.js';
import { ShadcnPlugin } from '../../src/indexer/plugins/integration/view/shadcn/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import type { ResolveContext, ChangeScope } from '../../src/plugin-api/types.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import * as eventLoop from '../../src/utils/event-loop.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('TRA-2524: event loop stall prevention during bulk indexing and concurrent reindexing', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = createTmpDir('tra-2524-');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
  });

  afterEach(() => {
    store.db.close();
    removeTmpDir(tmpDir);
    vi.restoreAllMocks();
  });

  describe('selectChangedFilesAsync event loop yielding', () => {
    it('yields to the event loop every 256 files on large file sets', async () => {
      const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');
      const relPaths = Array.from({ length: 700 }, (_, i) => `src/file_${i}.ts`);
      const existing = new Map();

      const result = await selectChangedFilesAsync(tmpDir, relPaths, existing, false);
      expect(result.candidates.length).toBe(700);
      // 700 files with yield every 256 files (i = 256, 512) -> at least 2 yields
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('detectRenamesAsync fast-path and yielding', () => {
    it('early-returns without reading files when store is empty', async () => {
      const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');
      const mockStore = {
        getAllFiles: vi.fn(() => []),
        updateFilePath: vi.fn(),
      };
      const existing = new Map();
      const result = await detectRenamesAsync(
        mockStore,
        tmpDir,
        ['src/a.ts', 'src/b.ts'],
        existing,
      );
      expect(result.renamed).toBe(0);
      expect(mockStore.getAllFiles).toHaveBeenCalledTimes(1);
      expect(yieldSpy).not.toHaveBeenCalled();
    });
  });

  describe('EdgeResolver workspace optimization (TRA-2524)', () => {
    it('skips workspaces with 0 indexed files in the DB and memoizes scopedCtx.getAllFiles', async () => {
      let getAllFilesCallCount = 0;
      const allFiles = [{ id: 1, path: 'packages/has-files/src/index.ts', language: 'typescript' }];

      const mockWsPlugin1 = {
        manifest: {
          name: 'plugin-1',
          version: '1.0.0',
          priority: 1,
          category: 'test',
          dependencies: [],
        },
        detect: (ctx: { rootPath: string }) => ctx.rootPath !== tmpDir,
        registerSchema: () => ({}),
        resolveEdges: vi.fn((ctx: ResolveContext) => {
          ctx.getAllFiles();
          ctx.getAllFiles();
          return ok([]);
        }),
      };

      const mockWsPlugin2 = {
        manifest: {
          name: 'plugin-2',
          version: '1.0.0',
          priority: 2,
          category: 'test',
          dependencies: [],
        },
        detect: (ctx: { rootPath: string }) => ctx.rootPath !== tmpDir,
        registerSchema: () => ({}),
        resolveEdges: vi.fn((ctx: ResolveContext) => {
          ctx.getAllFiles();
          return ok([]);
        }),
      };

      const registry = new PluginRegistry();
      registry.registerFrameworkPlugin(mockWsPlugin1 as any);
      registry.registerFrameworkPlugin(mockWsPlugin2 as any);

      const state: PipelineState = {
        db: store.db,
        store,
        registry,
        rootPath: tmpDir,
        workspaces: [
          { name: 'ws-empty', path: 'packages/empty' },
          { name: 'ws-has-files', path: 'packages/has-files' },
        ],
        config: {} as any,
      };

      const edgeResolver = new EdgeResolver(state);

      const resolveContext: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => {
          getAllFilesCallCount++;
          return allFiles;
        },
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: () => undefined,
      };

      await edgeResolver.resolveEdges({ rootPath: tmpDir } as any, resolveContext);

      // ws-empty should have been skipped entirely
      expect(mockWsPlugin1.resolveEdges).toHaveBeenCalledTimes(1);
      expect(mockWsPlugin2.resolveEdges).toHaveBeenCalledTimes(1);
      // Because getAllFiles() is hoisted outside the workspace loop and cached,
      // the base getAllFiles() should only be called once.
      expect(getAllFilesCallCount).toBe(1);
    });
  });

  describe('resolveTypeScriptHeritageEdges chunked commit and yields', () => {
    it('commits in chunks and yields to the event loop on large heritage graphs', async () => {
      const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');
      store.ensureEdgeType('ts_extends', 'core', 'ts_extends');
      store.ensureEdgeType('ts_implements', 'core', 'ts_implements');

      const fileId = store.insertFile(
        'src/models.ts',
        'typescript',
        'hash-models',
        100,
        null,
        1000,
      );

      // Insert 600 symbols with heritage (extends BaseClass)
      for (let i = 0; i < 600; i++) {
        store.insertSymbol(fileId, {
          name: `Class_${i}`,
          kind: 'class',
          symbolId: `src/models.ts::Class_${i}#class`,
          metadata: { extends: 'BaseClass' },
        });
      }

      // Base class
      store.insertSymbol(fileId, {
        name: 'BaseClass',
        kind: 'class',
        symbolId: 'src/models.ts::BaseClass#class',
      });

      const state: PipelineState = {
        db: store.db,
        store,
        registry: new PluginRegistry(),
        rootPath: tmpDir,
        workspaces: [],
        config: {} as any,
      };

      await resolveTypeScriptHeritageEdges(state);

      // 600 symbols processed in chunks of 250 -> at least 2 commit chunk yields,
      // plus pre-load query yields
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      const tsExtendsId = (
        store.db.prepare("SELECT id FROM edge_types WHERE name = 'ts_extends'").get() as {
          id: number;
        }
      ).id;
      const edgeCount = (
        store.db
          .prepare('SELECT count(*) as c FROM edges WHERE edge_type_id = ?')
          .get(tsExtendsId) as { c: number }
      ).c;
      expect(edgeCount).toBe(600);
    });
  });

  describe('resolveMemberOfEdges chunked commit and yields', () => {
    it('commits in chunks and yields to the event loop on tens of thousands of member rows', async () => {
      const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');
      store.ensureEdgeType('member_of', 'core', 'member_of');

      const fileId = store.insertFile('src/big.ts', 'typescript', 'hash-big', 100, null, 1000);
      const parentId = store.insertSymbol(fileId, {
        name: 'ParentClass',
        kind: 'class',
        symbolId: 'src/big.ts::ParentClass#class',
      });

      // Insert 800 members
      for (let i = 0; i < 800; i++) {
        store.insertSymbol(
          fileId,
          {
            name: `method_${i}`,
            kind: 'method',
            symbolId: `src/big.ts::ParentClass::method_${i}#method`,
          },
          parentId,
        );
      }

      const state: PipelineState = {
        db: store.db,
        store,
        registry: new PluginRegistry(),
        rootPath: tmpDir,
        workspaces: [],
        config: {} as any,
      };

      await resolveMemberOfEdges(state);

      // 800 items with RESOLVER_WRITE_CHUNK = 250 -> at least 3 chunk commits with yields
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

      const memberOfType = (
        store.db.prepare("SELECT id FROM edge_types WHERE name = 'member_of'").get() as {
          id: number;
        }
      ).id;
      const edgeCount = (
        store.db
          .prepare('SELECT count(*) as c FROM edges WHERE edge_type_id = ?')
          .get(memberOfType) as { c: number }
      ).c;
      expect(edgeCount).toBe(800);
    });
  });

  describe('Framework plugin cooperative yields during resolveEdges', () => {
    it('VueFrameworkPlugin yields periodically while scanning vue and composable symbols', async () => {
      const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');
      const plugin = new VueFrameworkPlugin();

      const vueFiles = Array.from({ length: 80 }, (_, i) => ({
        id: i + 1,
        path: `src/components/Comp_${i}.vue`,
        language: 'vue',
      }));

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => vueFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: () => undefined,
      };

      await plugin.resolveEdges(ctx);
      // 80 vue files yielding every 32 files -> at least 2 yields
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('NuxtPlugin yields periodically during resolveEdges', async () => {
      const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');
      const plugin = new NuxtPlugin();

      const vueFiles = Array.from({ length: 70 }, (_, i) => ({
        id: i + 1,
        path: `components/Comp_${i}.vue`,
        language: 'vue',
      }));

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => vueFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: () => undefined,
      };

      await plugin.resolveEdges(ctx);
      // 70 vue files yielding every 32 files -> at least 2 yields
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('TailwindPlugin yields periodically during resolveEdges', async () => {
      const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');
      const plugin = new TailwindPlugin();

      const cssFiles = Array.from({ length: 150 }, (_, i) => ({
        id: i + 1,
        path: `src/styles/style_${i}.css`,
        language: 'css',
      }));

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => cssFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: () => undefined,
      };

      await plugin.resolveEdges(ctx);
      // 150 css files yielding every 64 files -> at least 2 yields
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('ShadcnPlugin yields periodically during resolveEdges', async () => {
      const yieldSpy = vi.spyOn(eventLoop, 'yieldToEventLoopFair');
      const plugin = new ShadcnPlugin();

      const tsxFiles = Array.from({ length: 70 }, (_, i) => ({
        id: i + 1,
        path: `src/pages/Page_${i}.tsx`,
        language: 'typescript',
      }));

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => tsxFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: () => undefined,
      };

      await plugin.resolveEdges(ctx);
      // 70 consumer files yielding every 32 files -> at least 2 yields
      expect(yieldSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Event loop responsiveness during bulk processing', () => {
    it('keeps simulated /health heartbeats responding while heavy resolution runs', async () => {
      store.ensureEdgeType('member_of', 'core', 'member_of');
      const fileId = store.insertFile('src/big.ts', 'typescript', 'hash-big', 100, null, 1000);
      const parentId = store.insertSymbol(fileId, {
        name: 'ParentClass',
        kind: 'class',
        symbolId: 'src/big.ts::ParentClass#class',
      });

      for (let i = 0; i < 1500; i++) {
        store.insertSymbol(fileId, {
          name: `method_${i}`,
          kind: 'method',
          symbolId: `src/big.ts::ParentClass::method_${i}#method`,
          parentId,
        });
      }

      const state: PipelineState = {
        db: store.db,
        store,
        registry: new PluginRegistry(),
        rootPath: tmpDir,
        workspaces: [],
        config: {} as any,
      };

      // Start a simulated health check loop that checks latency every 10ms
      let maxTickLag = 0;
      let lastTick = Date.now();
      let stop = false;

      const healthTimer = setInterval(() => {
        const now = Date.now();
        const lag = now - lastTick - 10;
        if (lag > maxTickLag) maxTickLag = lag;
        lastTick = now;
        if (stop) clearInterval(healthTimer);
      }, 10);

      try {
        await resolveMemberOfEdges(state);
      } finally {
        stop = true;
        clearInterval(healthTimer);
      }

      // Max event loop lag observed by the health timer should stay well under 250ms
      expect(maxTickLag).toBeLessThan(250);
    });
  });
});
