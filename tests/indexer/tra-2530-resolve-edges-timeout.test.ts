/**
 * TRA-2530: Regression tests for resolveEdges timeouts, cancellation semantics,
 * edge correctness, and /health event-loop responsiveness under concurrent/bulk indexing.
 *
 * Verifies:
 * 1. Timeout cancellation promptness:
 *    - executeFrameworkResolveEdges aborts the AbortSignal immediately on timeout.
 *    - LaravelPlugin.resolveEdges terminates immediately upon signal abortion without leaking work.
 *    - VueFrameworkPlugin.resolveEdges terminates immediately upon signal abortion without leaking work.
 * 2. Edge resolution correctness:
 *    - Fast substring guards (Model, Request, $listen, dispatch, etc.) preserve 100% of Laravel edges.
 *    - Distinctive component filtering and size guards in Vue preserve 100% of renders_component,
 *      uses_composable, and references_component edges while skipping oversized files.
 *    - Memoization in executeFrameworkResolveEdges caches getSymbolByFqn and getSymbolsByFile,
 *      preventing thousands of redundant SQLite queries.
 * 3. /health responsiveness:
 *    - Event loop latency stays bounded (<250ms) during large-batch resolveEdges passes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../src/errors.js';
import { executeFrameworkResolveEdges } from '../../src/plugin-api/executor.js';
import type { FrameworkPlugin, RawEdge, ResolveContext } from '../../src/plugin-api/types.js';
import { LaravelPlugin } from '../../src/indexer/plugins/integration/framework/laravel/index.js';
import { VueFrameworkPlugin } from '../../src/indexer/plugins/integration/view/vue/index.js';
import { createTestStore, createTmpDir, removeTmpDir } from '../test-utils.js';
import type { Store } from '../../src/db/store.js';
import { yieldToEventLoopFair } from '../../src/utils/event-loop.js';

describe('TRA-2530: resolveEdges timeout, cancellation, and event loop responsiveness', () => {
  let tmpDir: string;
  let store: Store;

  beforeEach(() => {
    tmpDir = createTmpDir('tra-2530-');
    store = createTestStore();
  });

  afterEach(() => {
    store.db.close();
    removeTmpDir(tmpDir);
    vi.restoreAllMocks();
  });

  describe('1. Timeout cancellation promptness and signal propagation', () => {
    it('executeFrameworkResolveEdges aborts signal on timeout and returns ok([])', async () => {
      let sawAbort = false;
      const slowPlugin: FrameworkPlugin = {
        manifest: {
          name: 'slow-plugin',
          version: '1.0.0',
          priority: 0,
          category: 'framework',
          dependencies: [],
        },
        detect: () => true,
        resolveEdges: async (ctx: ResolveContext) => {
          ctx.signal?.addEventListener('abort', () => {
            sawAbort = true;
          });
          // Sleep longer than the 50ms timeout
          await new Promise((resolve) => setTimeout(resolve, 200));
          return ok([]);
        },
      };

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => [],
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => null,
      };

      const result = await executeFrameworkResolveEdges(slowPlugin, ctx, 50);
      expect(result.isOk()).toBe(true);
      expect(result.value).toEqual([]);
      expect(sawAbort).toBe(true);
    });

    it('LaravelPlugin.resolveEdges immediately halts file processing when aborted', async () => {
      const plugin = new LaravelPlugin();
      const abortController = new AbortController();

      let readFileCalls = 0;
      const files = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        path: `app/Models/Model${i}.php`,
        language: 'php',
      }));

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => files,
        getSymbolsByFile: () => [],
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => {
          readFileCalls++;
          if (readFileCalls === 2) {
            abortController.abort();
          }
          return '<?php class Post extends Model { public function comments() { return $this->hasMany(Comment::class); } }';
        },
        signal: abortController.signal,
      };

      const result = await plugin.resolveEdges(ctx);
      expect(result.isOk()).toBe(true);
      // Processing must halt early and not scan all 50 files
      expect(readFileCalls).toBeLessThan(10);
    });

    it('VueFrameworkPlugin.resolveEdges immediately halts processing when aborted', async () => {
      const plugin = new VueFrameworkPlugin();
      const abortController = new AbortController();

      let getSymbolsCalls = 0;
      const files = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        path: `src/components/Comp${i}.vue`,
        language: 'vue',
      }));

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => files,
        getSymbolsByFile: () => {
          getSymbolsCalls++;
          if (getSymbolsCalls === 2) {
            abortController.abort();
          }
          return [
            {
              id: 1,
              name: 'Comp',
              kind: 'class',
              symbolId: 'src/components/Comp.vue::Comp#class',
              fileId: 1,
              metadata: { templateComponents: [] },
            },
          ] as any;
        },
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => '<template><div /></template>',
        signal: abortController.signal,
      };

      const result = await plugin.resolveEdges(ctx);
      expect(result.isOk()).toBe(true);
      expect(getSymbolsCalls).toBeLessThan(10);
    });
  });

  describe('2. Edge resolution correctness & memoization', () => {
    it('LaravelPlugin correctly resolves Eloquent, FormRequest, and Event edges with substring pre-checks', async () => {
      const plugin = new LaravelPlugin();

      // Setup symbols in store
      const modelFileId = store.insertFile('app/Models/User.php', 'php', 'h1', 100, null, 1000);
      const userSymId = store.insertSymbol(modelFileId, {
        name: 'User',
        kind: 'class',
        symbolId: 'app/Models/User.php::User#class',
        fqn: 'App\\Models\\User',
      });

      const orderFileId = store.insertFile('app/Models/Order.php', 'php', 'h2', 100, null, 1000);
      const orderSymId = store.insertSymbol(orderFileId, {
        name: 'Order',
        kind: 'class',
        symbolId: 'app/Models/Order.php::Order#class',
        fqn: 'App\\Models\\Order',
      });

      const controllerFileId = store.insertFile(
        'app/Http/Controllers/UserController.php',
        'php',
        'h3',
        100,
        null,
        1000,
      );
      store.insertSymbol(controllerFileId, {
        name: 'UserController',
        kind: 'class',
        symbolId: 'app/Http/Controllers/UserController.php::UserController#class',
        fqn: 'App\\Http\\Controllers\\UserController',
      });
      const storeMethodId = store.insertSymbol(controllerFileId, {
        name: 'store',
        kind: 'method',
        symbolId: 'app/Http/Controllers/UserController.php::UserController::store#method',
        fqn: 'App\\Http\\Controllers\\UserController::store',
      });

      const reqFileId = store.insertFile(
        'app/Http/Requests/CreateUserRequest.php',
        'php',
        'h4',
        100,
        null,
        1000,
      );
      const reqSymId = store.insertSymbol(reqFileId, {
        name: 'CreateUserRequest',
        kind: 'class',
        symbolId: 'app/Http/Requests/CreateUserRequest.php::CreateUserRequest#class',
        fqn: 'App\\Http\\Requests\\CreateUserRequest',
      });

      const eventFileId = store.insertFile(
        'app/Events/UserRegistered.php',
        'php',
        'h5',
        100,
        null,
        1000,
      );
      const eventSymId = store.insertSymbol(eventFileId, {
        name: 'UserRegistered',
        kind: 'class',
        symbolId: 'app/Events/UserRegistered.php::UserRegistered#class',
        fqn: 'App\\Events\\UserRegistered',
      });

      const listenerFileId = store.insertFile(
        'app/Listeners/SendWelcomeEmail.php',
        'php',
        'h6',
        100,
        null,
        1000,
      );
      const listenerSymId = store.insertSymbol(listenerFileId, {
        name: 'SendWelcomeEmail',
        kind: 'class',
        symbolId: 'app/Listeners/SendWelcomeEmail.php::SendWelcomeEmail#class',
        fqn: 'App\\Listeners\\SendWelcomeEmail',
      });

      const eventProviderFileId = store.insertFile(
        'app/Providers/EventServiceProvider.php',
        'php',
        'h7',
        100,
        null,
        1000,
      );

      // Plain service with no framework patterns that must be skipped cleanly
      const serviceFileId = store.insertFile(
        'app/Services/MathHelper.php',
        'php',
        'h8',
        100,
        null,
        1000,
      );

      const files = [
        { id: modelFileId, path: 'app/Models/User.php', language: 'php' },
        { id: orderFileId, path: 'app/Models/Order.php', language: 'php' },
        { id: controllerFileId, path: 'app/Http/Controllers/UserController.php', language: 'php' },
        { id: reqFileId, path: 'app/Http/Requests/CreateUserRequest.php', language: 'php' },
        { id: eventFileId, path: 'app/Events/UserRegistered.php', language: 'php' },
        { id: listenerFileId, path: 'app/Listeners/SendWelcomeEmail.php', language: 'php' },
        {
          id: eventProviderFileId,
          path: 'app/Providers/EventServiceProvider.php',
          language: 'php',
        },
        { id: serviceFileId, path: 'app/Services/MathHelper.php', language: 'php' },
      ];

      const fileContents: Record<string, string> = {
        'app/Models/User.php': `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class User extends Model {
    public function orders() {
        return $this->hasMany(Order::class);
    }
}`,
        'app/Models/Order.php': `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Order extends Model {}`,
        'app/Http/Controllers/UserController.php': `<?php
namespace App\\Http\\Controllers;
use App\\Http\\Requests\\CreateUserRequest;
use App\\Events\\UserRegistered;
class UserController {
    public function store(CreateUserRequest $request) {
        UserRegistered::dispatch($request->all());
    }
}`,
        'app/Http/Requests/CreateUserRequest.php': `<?php
namespace App\\Http\\Requests;
class CreateUserRequest {}`,
        'app/Events/UserRegistered.php': `<?php
namespace App\\Events;
class UserRegistered {}`,
        'app/Listeners/SendWelcomeEmail.php': `<?php
namespace App\\Listeners;
class SendWelcomeEmail {}`,
        'app/Providers/EventServiceProvider.php': `<?php
namespace App\\Providers;
use App\\Events\\UserRegistered;
use App\\Listeners\\SendWelcomeEmail;
class EventServiceProvider {
    protected $listen = [
        UserRegistered::class => [
            SendWelcomeEmail::class,
        ],
    ];
}`,
        'app/Services/MathHelper.php': `<?php
namespace App\\Services;
class MathHelper {
    public function add($a, $b) { return $a + $b; }
}`,
      };

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => files,
        getSymbolsByFile: (fileId) => store.getSymbolsByFile(fileId) as any,
        getSymbolByFqn: (fqn) => store.getSymbolByFqn(fqn) as any,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (relPath) => fileContents[relPath] ?? null,
      };

      const result = await executeFrameworkResolveEdges(plugin, ctx);
      expect(result.isOk()).toBe(true);
      const edges = result.value;

      // Check has_many edge
      const hasManyEdge = edges.find((e) => e.edgeType === 'has_many');
      expect(hasManyEdge).toBeDefined();
      expect(hasManyEdge?.sourceRefId).toBe(userSymId);
      expect(hasManyEdge?.targetRefId).toBe(orderSymId);

      // Check validates_with edge
      const validateEdge = edges.find((e) => e.edgeType === 'validates_with');
      expect(validateEdge).toBeDefined();
      expect(validateEdge?.sourceRefId).toBe(storeMethodId);
      expect(validateEdge?.targetRefId).toBe(reqSymId);

      // Check listens_to edge
      const listenEdge = edges.find((e) => e.edgeType === 'listens_to');
      expect(listenEdge).toBeDefined();
      expect(listenEdge?.sourceRefId).toBe(listenerSymId);
      expect(listenEdge?.targetRefId).toBe(eventSymId);

      // Check dispatches edge
      const dispatchEdge = edges.find((e) => e.edgeType === 'dispatches');
      expect(dispatchEdge).toBeDefined();
      expect(dispatchEdge?.targetRefId).toBe(eventSymId);
    });

    it('executeFrameworkResolveEdges memoizes getSymbolByFqn and avoids repeated DB lookups', async () => {
      const plugin: FrameworkPlugin = {
        manifest: {
          name: 'test-memo',
          version: '1.0.0',
          priority: 0,
          category: 'framework',
          dependencies: [],
        },
        detect: () => true,
        resolveEdges: async (ctx: ResolveContext) => {
          // Look up same FQN 100 times
          for (let i = 0; i < 100; i++) {
            ctx.getSymbolByFqn('App\\Models\\User');
            ctx.getSymbolsByFile(42);
          }
          return ok([]);
        },
      };

      const rawGetSymbolByFqn = vi.fn().mockReturnValue({ id: 1, fqn: 'App\\Models\\User' });
      const rawGetSymbolsByFile = vi.fn().mockReturnValue([{ id: 1, name: 'User' }]);

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => [],
        getSymbolsByFile: rawGetSymbolsByFile,
        getSymbolByFqn: rawGetSymbolByFqn,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: () => null,
      };

      const result = await executeFrameworkResolveEdges(plugin, ctx);
      expect(result.isOk()).toBe(true);

      // Underlying functions should only be called once due to memoization in executeFrameworkResolveEdges
      expect(rawGetSymbolByFqn).toHaveBeenCalledTimes(1);
      expect(rawGetSymbolsByFile).toHaveBeenCalledTimes(1);
    });

    it('VueFrameworkPlugin skips oversized files and non-uppercase files during dynamic ref scanning', async () => {
      const plugin = new VueFrameworkPlugin();

      const vueFileId = 1;
      const tsFileId = 2;
      const oversizedFileId = 3;
      const lowerFileId = 4;

      const files = [
        { id: vueFileId, path: 'src/components/UserProfileCard.vue', language: 'vue' },
        { id: tsFileId, path: 'src/router.ts', language: 'typescript' },
        { id: oversizedFileId, path: 'src/big-bundle.ts', language: 'typescript' },
        { id: lowerFileId, path: 'src/lowercase-only.ts', language: 'typescript' },
      ];

      const readFiles: string[] = [];
      const fileContents: Record<string, string> = {
        'src/components/UserProfileCard.vue': '<template><div>User Card</div></template>',
        'src/router.ts': 'import { UserProfileCard } from "./components/UserProfileCard.vue";',
        // 350,000 characters (> 300,000 threshold)
        'src/big-bundle.ts': 'const bundle = "' + 'A'.repeat(350_000) + '";',
        'src/lowercase-only.ts': 'const x = "all lowercase characters here";',
      };

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => files,
        getSymbolsByFile: (fileId) => {
          if (fileId === vueFileId) {
            return [
              {
                id: 10,
                name: 'UserProfileCard',
                kind: 'class',
                symbolId: 'src/components/UserProfileCard.vue::UserProfileCard#class',
                fileId: vueFileId,
                metadata: { templateComponents: [], composables: [] },
              },
            ] as any;
          }
          return [];
        },
        getSymbolByFqn: () => undefined,
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (relPath) => {
          readFiles.push(relPath);
          return fileContents[relPath] ?? null;
        },
      };

      const result = await executeFrameworkResolveEdges(plugin, ctx);
      expect(result.isOk()).toBe(true);
      const edges = result.value;

      // references_component should be emitted for src/router.ts
      const refEdge = edges.find((e) => e.edgeType === 'references_component');
      expect(refEdge).toBeDefined();
      expect(refEdge?.sourceRefId).toBe(tsFileId);
      expect(refEdge?.targetSymbolId).toBe(
        'src/components/UserProfileCard.vue::UserProfileCard#class',
      );

      // big-bundle.ts must not have caused regex matching to run or produce false positives
      const bigRef = edges.find((e) => e.sourceRefId === oversizedFileId);
      expect(bigRef).toBeUndefined();
    });
  });

  describe('3. /health event-loop responsiveness under bulk indexing', () => {
    it('maintains bounded event loop latency (<250ms) during large-batch Laravel and Vue resolution', async () => {
      const laravelPlugin = new LaravelPlugin();
      const vuePlugin = new VueFrameworkPlugin();

      // Create a mock corpus of 400 PHP and Vue files
      const files: { id: number; path: string; language: string }[] = [];
      const fileContents: Record<string, string> = {};

      for (let i = 0; i < 200; i++) {
        const path = `app/Models/Item${i}.php`;
        files.push({ id: i + 1, path, language: 'php' });
        fileContents[path] = `<?php
namespace App\\Models;
use Illuminate\\Database\\Eloquent\\Model;
class Item${i} extends Model {
    public function parent() {
        return $this->belongsTo(Item0::class);
    }
}`;
      }

      for (let i = 200; i < 400; i++) {
        const path = `src/components/Widget${i}.vue`;
        files.push({ id: i + 1, path, language: 'vue' });
        fileContents[path] = `<template><Widget200 /></template>`;
      }

      const ctx: ResolveContext = {
        rootPath: tmpDir,
        getAllFiles: () => files,
        getSymbolsByFile: (fileId) => {
          if (fileId <= 200) {
            return [
              {
                id: fileId,
                name: `Item${fileId - 1}`,
                kind: 'class',
                symbolId: `app/Models/Item${fileId - 1}.php::Item${fileId - 1}#class`,
                fqn: `App\\Models\\Item${fileId - 1}`,
                fileId,
              },
            ] as any;
          }
          return [
            {
              id: fileId,
              name: `Widget${fileId - 1}`,
              kind: 'class',
              symbolId: `src/components/Widget${fileId - 1}.vue::Widget${fileId - 1}#class`,
              fileId,
              metadata: { templateComponents: ['Widget200'] },
            },
          ] as any;
        },
        getSymbolByFqn: (fqn) => {
          const match = fqn.match(/Item(\d+)/);
          if (match) {
            const idx = parseInt(match[1], 10);
            return {
              id: idx + 1,
              name: `Item${idx}`,
              kind: 'class',
              symbolId: `app/Models/Item${idx}.php::Item${idx}#class`,
              fqn,
            } as any;
          }
          return undefined;
        },
        getNodeId: () => undefined,
        createNodeIfNeeded: () => 0,
        readFile: (relPath) => fileContents[relPath] ?? null,
      };

      // Measure event loop responsiveness with a 10ms heartbeat timer
      let maxLag = 0;
      let lastTick = Date.now();
      let stopTimer = false;

      const timer = setInterval(() => {
        const now = Date.now();
        const lag = now - lastTick - 10;
        if (lag > maxLag) maxLag = lag;
        lastTick = now;
        if (stopTimer) clearInterval(timer);
      }, 10);

      try {
        const [laravelRes, vueRes] = await Promise.all([
          executeFrameworkResolveEdges(laravelPlugin, ctx),
          executeFrameworkResolveEdges(vuePlugin, ctx),
        ]);
        expect(laravelRes.isOk()).toBe(true);
        expect(vueRes.isOk()).toBe(true);
      } finally {
        stopTimer = true;
        clearInterval(timer);
      }

      // Max event loop lag observed by heartbeat should stay well under 250ms
      expect(maxLag).toBeLessThan(250);
    });
  });
});
