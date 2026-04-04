import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ReactNativePlugin,
  extractNavigatorScreens,
  extractNavigationCalls,
  extractExpoNavigationCalls,
  matchExpoRoute,
  isPlatformSpecificFile,
  getPlatform,
  hasNativeModuleUsage,
  extractNativeModuleNames,
} from '../../../src/indexer/plugins/integration/react-native/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

const RN6_FIXTURE = path.resolve(__dirname, '../../fixtures/react-navigation-6');

describe('ReactNativePlugin', () => {
  const plugin = new ReactNativePlugin();

  describe('detect()', () => {
    it('returns true for react-native project', () => {
      const ctx: ProjectContext = {
        rootPath: RN6_FIXTURE,
        packageJson: { dependencies: { 'react-native': '^0.76.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });

    it('returns false for web-only React project', () => {
      const ctx: ProjectContext = {
        rootPath: '/nonexistent/path',
        packageJson: { dependencies: { react: '^18.0.0' } },
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(false);
    });

    it('detects from disk', () => {
      const ctx: ProjectContext = {
        rootPath: RN6_FIXTURE,
        configFiles: [],
      };
      expect(plugin.detect(ctx)).toBe(true);
    });
  });

  describe('registerSchema()', () => {
    it('returns all expected edge types', () => {
      const schema = plugin.registerSchema();
      const edgeNames = schema.edgeTypes!.map((e) => e.name);
      expect(edgeNames).toContain('rn_navigates_to');
      expect(edgeNames).toContain('rn_screen_in_navigator');
      expect(edgeNames).toContain('rn_uses_native_module');
      expect(edgeNames).toContain('rn_platform_specific');
      expect(edgeNames).toContain('rn_deep_links_to');
    });
  });
});

describe('Navigator screen extraction (v6)', () => {
  const source = fs.readFileSync(
    path.join(RN6_FIXTURE, 'src/navigation/AppNavigator.tsx'),
    'utf-8',
  );

  it('extracts Stack.Screen definitions', () => {
    const screens = extractNavigatorScreens(source, 'AppNavigator.tsx');
    expect(screens.length).toBeGreaterThanOrEqual(3);

    const homeTabs = screens.find((s) => s.name === 'HomeTabs');
    expect(homeTabs).toBeDefined();
    expect(homeTabs!.componentPath).toBe('HomeTabs');

    const profile = screens.find((s) => s.name === 'Profile');
    expect(profile).toBeDefined();
    expect(profile!.componentPath).toBe('ProfileScreen');

    const settings = screens.find((s) => s.name === 'Settings');
    expect(settings).toBeDefined();
  });

  it('extracts Tab.Screen definitions', () => {
    const screens = extractNavigatorScreens(source, 'AppNavigator.tsx');
    const feed = screens.find((s) => s.name === 'Feed');
    expect(feed).toBeDefined();
    expect(feed!.componentPath).toBe('FeedScreen');

    const search = screens.find((s) => s.name === 'Search');
    expect(search).toBeDefined();
  });

  it('extracts deep link config', () => {
    const screens = extractNavigatorScreens(source, 'AppNavigator.tsx');
    const profile = screens.find((s) => s.name === 'Profile');
    expect(profile?.deepLink).toBe('user/:id');

    const settings = screens.find((s) => s.name === 'Settings');
    expect(settings?.deepLink).toBe('settings');
  });
});

describe('Navigator screen extraction (v4)', () => {
  it('extracts object-based navigator', () => {
    const source = `
import { createStackNavigator, createAppContainer } from 'react-navigation';

const AppNavigator = createStackNavigator({
  Home: { screen: HomeScreen },
  Profile: { screen: ProfileScreen },
  Settings: SettingsScreen,
});

const App = createAppContainer(AppNavigator);
`;
    const screens = extractNavigatorScreens(source, 'App.tsx');
    expect(screens.length).toBe(3);

    const home = screens.find((s) => s.name === 'Home');
    expect(home).toBeDefined();
    expect(home!.componentPath).toBe('HomeScreen');

    const settings = screens.find((s) => s.name === 'Settings');
    expect(settings).toBeDefined();
    expect(settings!.componentPath).toBe('SettingsScreen');
  });
});

describe('Navigation calls extraction', () => {
  it('extracts navigate calls', () => {
    const source = fs.readFileSync(
      path.join(RN6_FIXTURE, 'src/screens/HomeScreen.tsx'),
      'utf-8',
    );
    const targets = extractNavigationCalls(source);
    expect(targets).toContain('Profile');
    expect(targets).toContain('Settings');
  });

  it('extracts push calls', () => {
    const source = fs.readFileSync(
      path.join(RN6_FIXTURE, 'src/screens/ProfileScreen.tsx'),
      'utf-8',
    );
    const targets = extractNavigationCalls(source);
    expect(targets).toContain('Settings');
  });
});

describe('Platform-specific file detection', () => {
  it('detects iOS file', () => {
    expect(isPlatformSpecificFile('Component.ios.tsx')).toBe(true);
    expect(getPlatform('Component.ios.tsx')).toBe('ios');
  });

  it('detects Android file', () => {
    expect(isPlatformSpecificFile('Component.android.tsx')).toBe(true);
    expect(getPlatform('Component.android.tsx')).toBe('android');
  });

  it('detects native file', () => {
    expect(isPlatformSpecificFile('Component.native.ts')).toBe(true);
  });

  it('detects web file', () => {
    expect(isPlatformSpecificFile('Component.web.tsx')).toBe(true);
  });

  it('returns false for regular file', () => {
    expect(isPlatformSpecificFile('Component.tsx')).toBe(false);
    expect(getPlatform('Component.tsx')).toBeNull();
  });
});

describe('Native module detection', () => {
  it('detects NativeModules usage', () => {
    const source = fs.readFileSync(
      path.join(RN6_FIXTURE, 'src/screens/HomeScreen.tsx'),
      'utf-8',
    );
    expect(hasNativeModuleUsage(source)).toBe(true);
  });

  it('extracts module names from destructuring', () => {
    const source = fs.readFileSync(
      path.join(RN6_FIXTURE, 'src/screens/HomeScreen.tsx'),
      'utf-8',
    );
    const modules = extractNativeModuleNames(source);
    expect(modules).toContain('CameraModule');
  });

  it('detects TurboModuleRegistry usage', () => {
    const source = fs.readFileSync(
      path.join(RN6_FIXTURE, 'src/screens/ProfileScreen.tsx'),
      'utf-8',
    );
    expect(hasNativeModuleUsage(source)).toBe(true);
    const modules = extractNativeModuleNames(source);
    expect(modules).toContain('BiometricsModule');
  });

  it('detects requireNativeComponent', () => {
    const source = `
import { requireNativeComponent } from 'react-native';
const MyView = requireNativeComponent('RCTMyNativeView');
`;
    expect(hasNativeModuleUsage(source)).toBe(true);
    const modules = extractNativeModuleNames(source);
    expect(modules).toContain('RCTMyNativeView');
  });

  it('returns false for regular React code', () => {
    const source = `import React from 'react'; export const App = () => <div />;`;
    expect(hasNativeModuleUsage(source)).toBe(false);
  });
});

// ── Expo Router navigation calls ─────────────────────────────

describe('extractExpoNavigationCalls()', () => {
  it('extracts router.push() with string path', () => {
    const source = `router.push('/settings');`;
    expect(extractExpoNavigationCalls(source)).toContain('/settings');
  });

  it('extracts router.replace() with string path', () => {
    const source = `router.replace('/login');`;
    expect(extractExpoNavigationCalls(source)).toContain('/login');
  });

  it('extracts router.navigate() with string path', () => {
    const source = `router.navigate('/home');`;
    expect(extractExpoNavigationCalls(source)).toContain('/home');
  });

  it('extracts template literal paths with :param placeholder', () => {
    const source = 'router.push(`/profile/${id}`);';
    const calls = extractExpoNavigationCalls(source);
    expect(calls).toContain('/profile/:param');
  });

  it('extracts <Link href="..." />', () => {
    const source = `<Link href="/profile/123" />`;
    expect(extractExpoNavigationCalls(source)).toContain('/profile/123');
  });

  it('extracts router.push({ pathname: ... })', () => {
    const source = `router.push({ pathname: '/settings', params: { tab: 'general' } });`;
    expect(extractExpoNavigationCalls(source)).toContain('/settings');
  });

  it('deduplicates paths', () => {
    const source = `router.push('/home'); router.push('/home');`;
    expect(extractExpoNavigationCalls(source).filter((p) => p === '/home')).toHaveLength(1);
  });

  it('returns empty for non-expo source', () => {
    const source = `const x = 1;`;
    expect(extractExpoNavigationCalls(source)).toHaveLength(0);
  });
});

describe('matchExpoRoute()', () => {
  it('matches exact path', () => {
    expect(matchExpoRoute('/settings', '/settings')).toBe(true);
  });

  it('matches dynamic segment', () => {
    expect(matchExpoRoute('/profile/123', '/profile/:id')).toBe(true);
  });

  it('matches :param placeholder from template literals', () => {
    expect(matchExpoRoute('/profile/:param', '/profile/:id')).toBe(true);
  });

  it('does not match different path lengths', () => {
    expect(matchExpoRoute('/profile/123/posts', '/profile/:id')).toBe(false);
  });

  it('does not match different static segments', () => {
    expect(matchExpoRoute('/users/123', '/profile/:id')).toBe(false);
  });

  it('matches root path', () => {
    expect(matchExpoRoute('/', '/')).toBe(true);
  });

  it('matches catch-all route', () => {
    expect(matchExpoRoute('/blog/2024/hello-world', '/blog/*')).toBe(true);
  });
});
