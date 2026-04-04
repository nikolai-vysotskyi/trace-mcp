/**
 * Integration: React Navigation v6 through full pipeline.
 * Verifies screen extraction, navigation call resolution, and rn_navigates_to edges.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TraceMcpConfigSchema } from '../../src/config.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript/index.js';
import { ReactNativePlugin } from '../../src/indexer/plugins/integration/view/react-native/index.js';

describe('React Navigation v6 e2e', () => {
  let store: Store;

  beforeAll(async () => {
    const fixturePath = path.resolve(__dirname, '../fixtures/react-navigation-6');
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();

    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new ReactNativePlugin());

    const config = TraceMcpConfigSchema.parse({
      include: ['**/*.ts', '**/*.tsx'],
      exclude: ['node_modules/**'],
    });

    const pipeline = new IndexingPipeline(store, registry, config, fixturePath);
    await pipeline.indexAll();
  });

  it('indexes all fixture files', () => {
    const stats = store.getStats();
    expect(stats.totalFiles).toBeGreaterThanOrEqual(4);
  });

  it('extracts screens from navigator', () => {
    const screens = store.getAllRnScreens();
    expect(screens.length).toBeGreaterThan(0);

    const screenNames = screens.map((s) => s.name);
    expect(screenNames).toContain('HomeTabs');
    expect(screenNames).toContain('Profile');
    expect(screenNames).toContain('Settings');
  });

  it('creates rn_navigates_to edges from navigation calls', () => {
    const edges = store.getEdgesByType('rn_navigates_to');
    // HomeScreen.tsx navigates to Profile and Settings
    expect(edges.length).toBeGreaterThan(0);
  });

  it('detects native module usage', () => {
    const files = store.getAllFiles();
    const homeScreen = files.find((f) => f.path.includes('HomeScreen'));
    expect(homeScreen).toBeDefined();
    // HomeScreen uses NativeModules.CameraModule
    expect(homeScreen!.framework_role).toBe('rn_native_bridge');
  });
});
