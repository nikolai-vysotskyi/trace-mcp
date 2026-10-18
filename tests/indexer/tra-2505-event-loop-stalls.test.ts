import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { ok } from '../../src/errors.js';
import { EdgeResolver } from '../../src/indexer/edge-resolver.js';
import { resolvePhpCallEdges } from '../../src/indexer/edge-resolvers/php-calls.js';
import { resolveIacImportEdges } from '../../src/indexer/edge-resolvers/iac-imports.js';
import { InertiaPlugin } from '../../src/indexer/plugins/integration/view/inertia/index.js';
import { TailwindPlugin } from '../../src/indexer/plugins/integration/view/tailwind/index.js';
import { SortablePlugin } from '../../src/indexer/plugins/integration/view/sortable/index.js';
import { NuxtPlugin } from '../../src/indexer/plugins/integration/framework/nuxt/index.js';
import { ShadcnPlugin } from '../../src/indexer/plugins/integration/view/shadcn/index.js';
import { FilamentPlugin } from '../../src/indexer/plugins/integration/framework/filament/index.js';
import { DjangoPlugin } from '../../src/indexer/plugins/integration/framework/django/index.js';
import { FastAPIPlugin } from '../../src/indexer/plugins/integration/framework/fastapi/index.js';
import { UvicornPlugin } from '../../src/indexer/plugins/integration/tooling/uvicorn/index.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import type { ResolveContext, ChangeScope } from '../../src/plugin-api/types.js';
import type { PipelineState } from '../../src/indexer/pipeline-state.js';
import { createTmpDir, removeTmpDir } from '../test-utils.js';

describe('TRA-2505: event loop stall prevention during incremental reindexing on large graphs', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = createTmpDir('tra-2505-');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
  });

  afterEach(() => {
    store.db.close();
    removeTmpDir(tmpDir);
  });

  describe('EdgeResolver.resolveEdges workspace skipping (TRA-2505)', () => {
    it('skips workspace-level plugins when no changed files belong to that workspace', async () => {
      const mockWsPlugin = {
        manifest: {
          name: 'mock-ws-plugin',
          version: '1.0.0',
          priority: 10,
          category: 'test',
          dependencies: [],
        },
        detect: vi.fn((ctx: { rootPath: string }) => ctx.rootPath !== tmpDir),
        registerSchema: () => ({}),
        resolveEdges: vi.fn(() => ok([])),
      };

      const registry = new PluginRegistry();
      registry.registerFrameworkPlugin(mockWsPlugin as any);

      const state: PipelineState = {
        db: store.db,
        store,
        registry,
        rootPath: tmpDir,
        workspaces: [
          { name: 'ws-empty', path: 'packages/empty' },
          { name: 'ws-active', path: 'packages/active' },
        ],
        config: {} as any,
      };

      const edgeResolver = new EdgeResolver(state);

      const file1 = { id: 101, path: 'packages/active/src/index.ts', language: 'typescript' };
      const file2 = { id: 102, path: 'packages/empty/src/unused.ts', language: 'typescript' };

      const resolveContext: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => [file1, file2],
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: () => undefined,
        changeScope: {
          changedFileIds: new Set([101]),
          newSymbolNames: new Map(),
          deletedSymbolNames: new Map(),
        },
      };

      await edgeResolver.resolveEdges({ rootPath: tmpDir } as any, resolveContext);

      // Should have been called for ws-active (since file 101 is under packages/active/)
      // but NOT for ws-empty (file 102 was not in changeScope)
      expect(mockWsPlugin.resolveEdges).toHaveBeenCalledTimes(1);
    });

    it('runs all workspaces during full reindexing when scope is undefined', async () => {
      const mockWsPlugin = {
        manifest: {
          name: 'mock-ws-plugin',
          version: '1.0.0',
          priority: 10,
          category: 'test',
          dependencies: [],
        },
        detect: vi.fn((ctx: { rootPath: string }) => ctx.rootPath !== tmpDir),
        registerSchema: () => ({}),
        resolveEdges: vi.fn(() => ok([])),
      };

      const registry = new PluginRegistry();
      registry.registerFrameworkPlugin(mockWsPlugin as any);

      const state: PipelineState = {
        db: store.db,
        store,
        registry,
        rootPath: tmpDir,
        workspaces: [
          { name: 'ws-1', path: 'packages/ws1' },
          { name: 'ws-2', path: 'packages/ws2' },
        ],
        config: {} as any,
      };

      const edgeResolver = new EdgeResolver(state);

      const resolveContext: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => [
          { id: 1, path: 'packages/ws1/a.ts', language: 'typescript' },
          { id: 2, path: 'packages/ws2/b.ts', language: 'typescript' },
        ],
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: () => undefined,
      };

      await edgeResolver.resolveEdges({ rootPath: tmpDir } as any, resolveContext);

      expect(mockWsPlugin.resolveEdges).toHaveBeenCalledTimes(2);
    });
  });

  describe('resolvePhpCallEdges fast-path and chunking (TRA-2505)', () => {
    it('returns immediately without querying symbols when no changed files are PHP', async () => {
      // Insert non-PHP file into store
      store.insertFile('data/records.tsv', 'tsv', 'hash-tsv', 50, null, 1000);
      // Insert PHP file into store
      store.insertFile('app/Models/User.php', 'php', 'hash-php', 500, null, 1000);

      const tsvFile = store.getFile('data/records.tsv')!;
      const phpFile = store.getFile('app/Models/User.php')!;

      // Insert dummy symbols for PHP file
      for (let i = 0; i < 50; i++) {
        store.insertSymbol(phpFile.id, {
          name: `method_${i}`,
          kind: 'method',
          symbolId: `app/Models/User.php::User::method_${i}#method`,
          fqn: `App\\Models\\User::method_${i}`,
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

      const prepareSpy = vi.spyOn(store.db, 'prepare');

      const scope: ChangeScope = {
        changedFileIds: new Set([tsvFile.id]),
        newSymbolNames: new Map(),
        deletedSymbolNames: new Map(),
      };

      await resolvePhpCallEdges(state, scope);

      // Verify that allSymbols SELECT (WHERE f.language = 'php') was NEVER executed
      const executedQueries = prepareSpy.mock.calls.map((c) => c[0] as string);
      const queriedAllPhpSymbols = executedQueries.some((q) =>
        q.includes("WHERE f.language = 'php'"),
      );
      expect(queriedAllPhpSymbols).toBe(false);
    });
  });

  describe('resolveIacImportEdges fast-path (TRA-2505)', () => {
    it('returns immediately when changed files contain no IaC manifests', () => {
      store.insertFile('src/app.ts', 'typescript', 'hash-ts', 100, null, 1000);
      const file = store.getFile('src/app.ts')!;

      const state: PipelineState = {
        db: store.db,
        store,
        registry: new PluginRegistry(),
        rootPath: tmpDir,
        workspaces: [],
        config: {} as any,
      };

      const prepareSpy = vi.spyOn(store.db, 'prepare');

      const scope: ChangeScope = {
        changedFileIds: new Set([file.id]),
        newSymbolNames: new Map(),
        deletedSymbolNames: new Map(),
      };

      resolveIacImportEdges(state, scope);

      // Should not query edges table
      const executedQueries = prepareSpy.mock.calls.map((c) => c[0] as string);
      const queriedEdges = executedQueries.some((q) => q.includes('FROM edges e'));
      expect(queriedEdges).toBe(false);
    });
  });

  describe('Framework plugin scope-aware fast paths (TRA-2505)', () => {
    const nonTargetScope: ChangeScope = {
      changedFileIds: new Set([999]),
      newSymbolNames: new Map(),
      deletedSymbolNames: new Map(),
    };

    const mockFiles = [
      { id: 999, path: 'data/feed.tsv', language: 'tsv' },
      { id: 1, path: 'app/Http/Controllers/HomeController.php', language: 'php' },
      { id: 2, path: 'resources/css/app.css', language: 'css' },
      { id: 3, path: 'resources/js/components/List.vue', language: 'vue' },
      { id: 4, path: 'src/main.py', language: 'python' },
    ];

    it('InertiaPlugin skips file reading when changed files contain no PHP', async () => {
      const plugin = new InertiaPlugin();
      const readFileSpy = vi.fn();
      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => mockFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: readFileSpy,
        changeScope: nonTargetScope,
      };

      const res = await plugin.resolveEdges(ctx);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('TailwindPlugin skips file reading when changed files contain no CSS/templates', async () => {
      const plugin = new TailwindPlugin();
      const readFileSpy = vi.fn();
      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => mockFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: readFileSpy,
        changeScope: nonTargetScope,
      };

      const res = await plugin.resolveEdges(ctx);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('SortablePlugin skips file reading when changed files contain no TS/JS/Vue', () => {
      const plugin = new SortablePlugin();
      const readFileSpy = vi.fn();
      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => mockFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: readFileSpy,
        changeScope: nonTargetScope,
      };

      const res = plugin.resolveEdges(ctx);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('NuxtPlugin skips file reading when changed files contain no Vue/TS/JS', async () => {
      const plugin = new NuxtPlugin();
      const readFileSpy = vi.fn();
      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => mockFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: readFileSpy,
        changeScope: nonTargetScope,
      };

      const res = await plugin.resolveEdges(ctx);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('ShadcnPlugin skips file reading when changed files contain no consumer files', async () => {
      const plugin = new ShadcnPlugin();
      const readFileSpy = vi.fn();
      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => mockFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: readFileSpy,
        changeScope: nonTargetScope,
      };

      const res = await plugin.resolveEdges(ctx);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('FilamentPlugin skips file reading when changed files contain no PHP', () => {
      const plugin = new FilamentPlugin();
      const readFileSpy = vi.fn();
      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => mockFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: readFileSpy,
        changeScope: nonTargetScope,
      };

      const res = plugin.resolveEdges(ctx);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('DjangoPlugin skips file reading when changed files contain no Python', () => {
      const plugin = new DjangoPlugin();
      const readFileSpy = vi.fn();
      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => mockFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: readFileSpy,
        changeScope: nonTargetScope,
      };

      const res = plugin.resolveEdges(ctx);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('FastAPIPlugin skips file reading when changed files contain no Python', () => {
      const plugin = new FastAPIPlugin();
      const readFileSpy = vi.fn();
      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => mockFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: readFileSpy,
        changeScope: nonTargetScope,
      };

      const res = plugin.resolveEdges(ctx);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);
      expect(readFileSpy).not.toHaveBeenCalled();
    });

    it('UvicornPlugin skips file reading when changed files contain no Python', () => {
      const plugin = new UvicornPlugin();
      const readFileSpy = vi.fn();
      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => mockFiles,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 1,
        readFile: readFileSpy,
        changeScope: nonTargetScope,
      };

      const res = plugin.resolveEdges(ctx);
      expect(res.isOk()).toBe(true);
      expect(res._unsafeUnwrap()).toEqual([]);
      expect(readFileSpy).not.toHaveBeenCalled();
    });
  });
});
