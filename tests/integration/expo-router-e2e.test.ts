/**
 * Expo Router E2E integration test.
 * Indexes the expo-router-3 fixture and verifies that:
 * - app/ files are recognized as expo_route / expo_layout
 * - Route names are derived from file paths
 * - Dynamic segments become :param
 * - Route groups (tabs) are stripped from paths
 * - _layout files get expo_layout role, not expo_route
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { initializeDatabase } from '../../src/db/schema.js';
import { Store } from '../../src/db/store.js';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import { IndexingPipeline } from '../../src/indexer/pipeline.js';
import { TypeScriptLanguagePlugin } from '../../src/indexer/plugins/language/typescript.js';
import { ReactNativePlugin } from '../../src/indexer/plugins/framework/react-native/index.js';
import { getNavigationGraph } from '../../src/tools/rn-navigation.js';
import { getScreenContext } from '../../src/tools/screen-context.js';
import type { TraceMcpConfig } from '../../src/config.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/expo-router-3');

function makeConfig(): TraceMcpConfig {
  return {
    root: FIXTURE,
    include: ['app/**/*.tsx', 'app/**/*.ts'],
    exclude: ['node_modules/**'],
    db: { path: ':memory:' },
    plugins: [],
  };
}

describe('Expo Router E2E', () => {
  let store: Store;

  beforeAll(async () => {
    const db = initializeDatabase(':memory:');
    store = new Store(db);
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(new TypeScriptLanguagePlugin());
    registry.registerFrameworkPlugin(new ReactNativePlugin());

    const config = makeConfig();
    const pipeline = new IndexingPipeline(store, registry, config, FIXTURE);
    await pipeline.indexAll();
  });

  it('indexes expo app/ files as screens', () => {
    const allScreens = store.getAllRnScreens();
    expect(allScreens.length).toBeGreaterThan(0);
  });

  it('creates screens with route-based names', () => {
    const screens = store.getAllRnScreens();
    const names = screens.map((s) => s.name);

    // app/index.tsx → /
    expect(names).toContain('/');
    // app/profile/[id].tsx → /profile/:id
    expect(names).toContain('/profile/:id');
    // app/(tabs)/feed.tsx → /feed (group stripped)
    expect(names).toContain('/feed');
    // app/settings/index.tsx → /settings
    expect(names).toContain('/settings');
  });

  it('does not create screens for _layout files', () => {
    const screens = store.getAllRnScreens();
    // _layout files should NOT produce screen entries
    const layoutScreens = screens.filter((s) => s.name.includes('_layout'));
    expect(layoutScreens).toHaveLength(0);
  });

  it('sets deepLink from route path', () => {
    const screens = store.getAllRnScreens();
    const profile = screens.find((s) => s.name === '/profile/:id');
    expect(profile).toBeDefined();
    expect(profile!.deep_link).toBe('/profile/:id');
  });

  it('files have expo_route framework role', () => {
    const allFiles = store.getAllFiles();
    const expoRoutes = allFiles.filter((f) => f.framework_role === 'expo_route');
    expect(expoRoutes.length).toBeGreaterThan(0);
  });

  it('layout files have expo_layout framework role', () => {
    const allFiles = store.getAllFiles();
    const layouts = allFiles.filter((f) => f.framework_role === 'expo_layout');
    expect(layouts.length).toBeGreaterThan(0);
  });

  it('getNavigationGraph works with expo routes', () => {
    const result = getNavigationGraph(store);
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.totalScreens).toBeGreaterThan(0);
    const screenNames = result.value.screens.map((s) => s.screen);
    expect(screenNames).toContain('/profile/:id');
  });

  it('getScreenContext finds Expo screen by route', () => {
    const result = getScreenContext(store, '/profile/:id');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.screen).toBe('/profile/:id');
    expect(result.value.deepLink).toBe('/profile/:id');
  });

  it('getScreenContext finds Expo screen by partial name', () => {
    const result = getScreenContext(store, 'profile');
    expect(result.isOk()).toBe(true);
  });
});
