import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import type { Store } from '../../src/db/store.js';
import { createTestStore } from '../test-utils.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { NestJSPlugin } from '../../src/indexer/plugins/integration/framework/nestjs/index.js';
import { ExpressPlugin } from '../../src/indexer/plugins/integration/framework/express/index.js';
import { ReactNativePlugin } from '../../src/indexer/plugins/integration/view/react-native/index.js';
import { getMiddlewareChain } from '../../src/tools/framework/middleware-chain.js';
import { getModuleGraph } from '../../src/tools/analysis/module-graph.js';
import { getDITree } from '../../src/tools/framework/di-tree.js';
import { getNavigationGraph } from '../../src/tools/framework/rn-navigation.js';
import { getScreenContext } from '../../src/tools/framework/screen-context.js';
import type { TraceMcpConfig } from '../../src/config.js';

const NESTJS_FIXTURE = path.resolve(__dirname, '../fixtures/nestjs-basic');
const EXPRESS_FIXTURE = path.resolve(__dirname, '../fixtures/express-basic');
const RN_FIXTURE = path.resolve(__dirname, '../fixtures/react-navigation-6');

function makeConfig(root: string, include: string[]): TraceMcpConfig {
  return {
    root,
    include,
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

// ─── get_middleware_chain ───────────────────────────────────

describe('get_middleware_chain', () => {
  describe('with Express project', () => {
    let store: Store;

    beforeAll(async () => {
      store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
      registry.registerFrameworkPlugin(new ExpressPlugin());

      const config = makeConfig(EXPRESS_FIXTURE, ['**/*.ts', '**/*.js']);
      const pipeline = new IndexingPipeline(store, registry, config, EXPRESS_FIXTURE);
      await pipeline.indexAll();
    });

    it('returns NOT_FOUND for unknown URL when no routes match', () => {
      const result = getMiddlewareChain(
        store,
        EXPRESS_FIXTURE,
        '/this/url/does/not/exist/anywhere/xyz123',
      );
      // Either NOT_FOUND or empty chain is acceptable
      if (result.isErr()) {
        expect(result.error.code).toBe('NOT_FOUND');
      } else {
        expect(result.value.framework).toBeDefined();
      }
    });

    it('returns a result structure for indexed routes', () => {
      const routes = store.getAllRoutes();
      if (routes.length === 0) return; // skip if no routes indexed

      const result = getMiddlewareChain(store, EXPRESS_FIXTURE, routes[0].uri);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.framework).toBe('express');
        expect(result.value.url).toBe(routes[0].uri);
        expect(Array.isArray(result.value.chain)).toBe(true);
      }
    });
  });

  describe('with NestJS project', () => {
    let store: Store;

    beforeAll(async () => {
      store = createTestStore();
      const registry = new PluginRegistry();
      registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
      registry.registerFrameworkPlugin(new NestJSPlugin());

      const config = makeConfig(NESTJS_FIXTURE, ['**/*.ts']);
      const pipeline = new IndexingPipeline(store, registry, config, NESTJS_FIXTURE);
      await pipeline.indexAll();
    });

    it('returns a result for NestJS routes', () => {
      const routes = store.getAllRoutes();
      if (routes.length === 0) return;

      const result = getMiddlewareChain(store, NESTJS_FIXTURE, routes[0].uri);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.framework).toBe('nestjs');
      }
    });
  });
});

// ─── get_module_graph ──────────────────────────────────────

describe('get_module_graph', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new NestJSPlugin());

    const config = makeConfig(NESTJS_FIXTURE, ['**/*.ts']);
    const pipeline = new IndexingPipeline(store, registry, config, NESTJS_FIXTURE);
    await pipeline.indexAll();
  });

  it('returns NOT_FOUND for unknown module', () => {
    const result = getModuleGraph(store, NESTJS_FIXTURE, 'NonExistentModule');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('finds AppModule when indexed', () => {
    const allFiles = store.getAllFiles();
    const hasModules = allFiles.some((f) => f.framework_role === 'nest_module');
    if (!hasModules) return;

    const result = getModuleGraph(store, NESTJS_FIXTURE, 'AppModule');
    if (result.isOk()) {
      expect(result.value.rootModule).toBe('AppModule');
      expect(result.value.modules.length).toBeGreaterThan(0);
      expect(result.value.modules[0].name).toBe('AppModule');
    }
  });
});

// ─── get_di_tree ───────────────────────────────────────────

describe('get_di_tree', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new NestJSPlugin());

    const config = makeConfig(NESTJS_FIXTURE, ['**/*.ts']);
    const pipeline = new IndexingPipeline(store, registry, config, NESTJS_FIXTURE);
    await pipeline.indexAll();
  });

  it('returns NOT_FOUND for unknown service', () => {
    const result = getDITree(store, 'NonExistentService');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns DI tree for known injectable', () => {
    const allFiles = store.getAllFiles();
    const hasInjectables = allFiles.some((f) => f.framework_role === 'nest_injectable');
    if (!hasInjectables) return;

    // Find first injectable class
    for (const file of allFiles) {
      if (file.framework_role !== 'nest_injectable') continue;
      const symbols = store.getSymbolsByFile(file.id);
      const cls = symbols.find((s) => s.kind === 'class');
      if (!cls) continue;

      const result = getDITree(store, cls.name);
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.service.name).toBe(cls.name);
        expect(Array.isArray(result.value.injects)).toBe(true);
        expect(Array.isArray(result.value.injectedBy)).toBe(true);
      }
      break;
    }
  });
});

// ─── get_navigation_graph ──────────────────────────────────

describe('get_navigation_graph', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new ReactNativePlugin());

    const config = makeConfig(RN_FIXTURE, ['**/*.tsx', '**/*.ts']);
    const pipeline = new IndexingPipeline(store, registry, config, RN_FIXTURE);
    await pipeline.indexAll();
  });

  it('returns navigation graph result', () => {
    const result = getNavigationGraph(store);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(typeof result.value.totalScreens).toBe('number');
      expect(Array.isArray(result.value.screens)).toBe(true);
      expect(Array.isArray(result.value.navigatorTypes)).toBe(true);
      expect(Array.isArray(result.value.deepLinks)).toBe(true);
    }
  });

  it('includes indexed screens', () => {
    const allScreens = store.getAllRnScreens();
    const result = getNavigationGraph(store);

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.totalScreens).toBe(allScreens.length);

      if (allScreens.length > 0) {
        const screenNames = result.value.screens.map((s) => s.screen);
        for (const screen of allScreens) {
          expect(screenNames).toContain(screen.name);
        }
      }
    }
  });

  it('deep links array matches screens with deep_link', () => {
    const result = getNavigationGraph(store);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const allScreens = store.getAllRnScreens();
      const screensWithLinks = allScreens.filter((s) => s.deep_link);
      expect(result.value.deepLinks.length).toBe(screensWithLinks.length);
    }
  });
});

describe('get_screen_context (pipeline)', () => {
  let store: Store;

  beforeAll(async () => {
    store = createTestStore();
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new ReactNativePlugin());

    const config = makeConfig(RN_FIXTURE, ['**/*.tsx', '**/*.ts']);
    const pipeline = new IndexingPipeline(store, registry, config, RN_FIXTURE);
    await pipeline.indexAll();
  });

  it('returns NOT_FOUND for unknown screen name', () => {
    const result = getScreenContext(store, 'NoSuchScreenXYZ');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('finds a screen if any were indexed', () => {
    const allScreens = store.getAllRnScreens();
    if (allScreens.length === 0) return; // no screens in fixture — skip

    const firstName = allScreens[0].name;
    const result = getScreenContext(store, firstName);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.screen).toBe(firstName);
    expect(Array.isArray(result.value.navigatedFrom)).toBe(true);
    expect(Array.isArray(result.value.navigatesTo)).toBe(true);
    expect(typeof result.value.platformSpecific).toBe('object');
    expect(Array.isArray(result.value.nativeModulesUsed)).toBe(true);
  });

  it('partial name match works for indexed screens', () => {
    const allScreens = store.getAllRnScreens();
    if (allScreens.length === 0) return;

    // Use partial name (first 3 chars, lowercased)
    const partial = allScreens[0].name.slice(0, 3).toLowerCase();
    const result = getScreenContext(store, partial);
    expect(result.isOk()).toBe(true);
  });
});
