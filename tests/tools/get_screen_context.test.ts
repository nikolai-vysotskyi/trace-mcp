/**
 * Tests for get_screen_context tool.
 * Uses in-memory store populated via insertRnScreen to avoid full pipeline.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../../src/db/store.js';
import { getScreenContext } from '../../src/tools/framework/screen-context.js';
import { createTestStore } from '../test-utils.js';

describe('get_screen_context', () => {
  let store: Store;
  let fileId: number;

  beforeEach(() => {
    store = createTestStore();
    fileId = store.insertFile('src/screens/ProfileScreen.tsx', 'typescript', 'h1', 200);
  });

  it('finds a screen by exact name', () => {
    store.insertRnScreen(
      { name: 'Profile', componentPath: 'ProfileScreen', navigatorType: 'stack' },
      fileId,
    );

    const result = getScreenContext(store, 'Profile');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.screen).toBe('Profile');
    expect(result.value.component).toBe('ProfileScreen');
    expect(result.value.navigatorType).toBe('stack');
    expect(result.value.filePath).toContain('ProfileScreen.tsx');
  });

  it('finds a screen by partial name (case-insensitive)', () => {
    store.insertRnScreen(
      { name: 'ProfileScreen', componentPath: 'ProfileScreen', navigatorType: 'stack' },
      fileId,
    );

    const result = getScreenContext(store, 'profile');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.screen).toBe('ProfileScreen');
  });

  it('returns NOT_FOUND for unknown screen', () => {
    const result = getScreenContext(store, 'NonExistentScreen');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns deep link when present', () => {
    store.insertRnScreen(
      {
        name: 'Profile',
        componentPath: 'ProfileScreen',
        navigatorType: 'stack',
        deepLink: 'user/:id',
      },
      fileId,
    );

    const result = getScreenContext(store, 'Profile');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.deepLink).toBe('user/:id');
  });

  it('computes navigatedFrom from other screens metadata', () => {
    const homeFileId = store.insertFile('src/screens/HomeScreen.tsx', 'typescript', 'h2', 100);

    // Profile screen
    store.insertRnScreen(
      { name: 'Profile', componentPath: 'ProfileScreen', navigatorType: 'stack' },
      fileId,
    );

    // Home screen navigates to Profile
    store.insertRnScreen(
      {
        name: 'Home',
        componentPath: 'HomeScreen',
        navigatorType: 'tab',
        metadata: { navigationCalls: ['Profile'] },
      },
      homeFileId,
    );

    const result = getScreenContext(store, 'Profile');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.navigatedFrom).toContain('Home');
  });

  it('computes navigatesTo from metadata.navigationCalls', () => {
    const settingsFileId = store.insertFile(
      'src/screens/SettingsScreen.tsx',
      'typescript',
      'h3',
      100,
    );

    store.insertRnScreen(
      { name: 'Settings', componentPath: 'SettingsScreen', navigatorType: 'stack' },
      settingsFileId,
    );
    store.insertRnScreen(
      {
        name: 'Profile',
        componentPath: 'ProfileScreen',
        navigatorType: 'stack',
        metadata: { navigationCalls: ['Settings'] },
      },
      fileId,
    );

    const result = getScreenContext(store, 'Profile');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.navigatesTo).toContain('Settings');
  });

  it('returns native modules from metadata', () => {
    store.insertRnScreen(
      {
        name: 'Profile',
        componentPath: 'ProfileScreen',
        navigatorType: 'stack',
        metadata: { nativeModules: ['CameraModule', 'LocationModule'] },
      },
      fileId,
    );

    const result = getScreenContext(store, 'Profile');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.nativeModulesUsed).toContain('CameraModule');
    expect(result.value.nativeModulesUsed).toContain('LocationModule');
  });

  it('returns platform-specific variants from metadata', () => {
    store.insertRnScreen(
      {
        name: 'Profile',
        componentPath: 'ProfileScreen',
        navigatorType: 'stack',
        metadata: {
          platformSpecific: {
            ios: 'ProfileScreen.ios.tsx',
            android: 'ProfileScreen.android.tsx',
          },
        },
      },
      fileId,
    );

    const result = getScreenContext(store, 'Profile');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.platformSpecific).toEqual({
      ios: 'ProfileScreen.ios.tsx',
      android: 'ProfileScreen.android.tsx',
    });
  });

  it('returns empty arrays when no navigation data', () => {
    store.insertRnScreen({ name: 'Profile', componentPath: 'ProfileScreen' }, fileId);

    const result = getScreenContext(store, 'Profile');
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    expect(result.value.navigatedFrom).toHaveLength(0);
    expect(result.value.navigatesTo).toHaveLength(0);
    expect(result.value.nativeModulesUsed).toHaveLength(0);
    expect(result.value.platformSpecific).toEqual({});
  });
});
