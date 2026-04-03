/**
 * ReactNativePlugin — Framework plugin for React Native applications.
 *
 * Extracts:
 * - React Navigation graph (v3-v6): screens, navigators, nesting
 * - navigation.navigate() → screen edges
 * - Deep linking configuration
 * - Platform-specific files (.ios.tsx, .android.tsx)
 * - NativeModules / TurboModuleRegistry usage
 * - Expo Router file-based routing
 *
 * Supports RN 0.50+ and React Navigation v3-v6.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok } from 'neverthrow';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawRnScreen,
  ResolveContext,
} from '../../../../plugin-api/types.js';
import type { TraceMcpResult } from '../../../../errors.js';

export class ReactNativePlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'react-native',
    version: '1.0.0',
    priority: 20,
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    const deps = {
      ...(ctx.packageJson?.dependencies as Record<string, string> | undefined),
      ...(ctx.packageJson?.devDependencies as Record<string, string> | undefined),
    };
    if ('react-native' in deps) return true;

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const json = JSON.parse(content);
      const allDeps = { ...json.dependencies, ...json.devDependencies };
      return 'react-native' in allDeps;
    } catch {
      return false;
    }
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'rn_navigates_to', category: 'react-native', description: 'navigation.navigate() to screen' },
        { name: 'rn_screen_in_navigator', category: 'react-native', description: 'Screen registered in navigator' },
        { name: 'rn_uses_native_module', category: 'react-native', description: 'Uses NativeModules/TurboModuleRegistry' },
        { name: 'rn_platform_specific', category: 'react-native', description: 'Platform-specific file variant' },
        { name: 'rn_deep_links_to', category: 'react-native', description: 'Deep link maps to screen' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'typescript' && language !== 'javascript') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      rnScreens: [],
      warnings: [],
    };

    // Extract screens from navigator definitions
    const screens = extractNavigatorScreens(source, filePath);
    if (screens.length > 0) {
      result.rnScreens = screens;
      result.frameworkRole = 'rn_navigator';
    }

    // Detect platform-specific file
    if (isPlatformSpecificFile(filePath)) {
      result.frameworkRole = 'rn_platform_specific';
    }

    // Detect native module usage
    if (hasNativeModuleUsage(source)) {
      result.frameworkRole = result.frameworkRole ?? 'rn_native_bridge';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}

// ============================================================
// Navigator screen extraction
// ============================================================

/**
 * Extract screens from React Navigation navigator definitions.
 * Handles v6, v5, v4, and v3 patterns.
 */
export function extractNavigatorScreens(
  source: string,
  filePath: string,
): RawRnScreen[] {
  const screens: RawRnScreen[] = [];

  // Detect navigator type from creation call
  const navigatorType = detectNavigatorType(source);

  // v5-v6 JSX: <Stack.Screen name="Home" component={HomeScreen} />
  const jsxScreenRegex = /<(\w+)\.Screen\s+([^>]*?)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = jsxScreenRegex.exec(source)) !== null) {
    const attrs = match[2];
    const nameMatch = attrs.match(/name\s*=\s*["']([^"']+)["']/);
    const componentMatch = attrs.match(/component\s*=\s*\{(\w+)\}/);

    if (nameMatch) {
      screens.push({
        name: nameMatch[1],
        componentPath: componentMatch?.[1],
        navigatorType: navigatorType ?? 'stack',
      });
    }
  }

  // v4 object syntax: createStackNavigator({ Home: { screen: HomeScreen }, ... })
  const v4StartRegex = /create(?:Stack|Tab|Drawer|BottomTab|MaterialTopTab)Navigator\s*\(\s*\{/;
  const v4StartMatch = v4StartRegex.exec(source);
  if (v4StartMatch && screens.length === 0) {
    const startIdx = v4StartMatch.index + v4StartMatch[0].length;
    // Use brace-counting to find the matching closing brace
    let depth = 1;
    let i = startIdx;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      i++;
    }
    const body = source.substring(startIdx, i - 1);

    // Match: Home: { screen: HomeScreen } or Home: HomeScreen
    const screenRegex = /(\w+)\s*:\s*(?:\{\s*screen\s*:\s*(\w+)|(\w+))/g;
    let sm: RegExpExecArray | null;
    while ((sm = screenRegex.exec(body)) !== null) {
      const screenName = sm[1];
      const component = sm[2] ?? sm[3];
      // Skip navigator option keys and sub-object keys
      if (['initialRouteName', 'navigationOptions', 'defaultNavigationOptions', 'mode', 'headerMode', 'screen'].includes(screenName)) continue;
      screens.push({
        name: screenName,
        componentPath: component,
        navigatorType: navigatorType ?? 'stack',
      });
    }
  }

  // Extract deep linking config
  const deepLinks = extractDeepLinkConfig(source);
  for (const screen of screens) {
    const link = deepLinks.get(screen.name);
    if (link) {
      screen.deepLink = link;
    }
  }

  return screens;
}

/**
 * Detect the navigator type from creation calls.
 */
function detectNavigatorType(source: string): RawRnScreen['navigatorType'] | undefined {
  if (/createNativeStackNavigator|createStackNavigator/.test(source)) return 'native-stack';
  if (/createBottomTabNavigator|createMaterialTopTabNavigator|createTabNavigator/.test(source)) return 'tab';
  if (/createDrawerNavigator/.test(source)) return 'drawer';
  return undefined;
}

/**
 * Extract navigation.navigate() calls → which screens are navigated to.
 */
export function extractNavigationCalls(source: string): string[] {
  const targets: string[] = [];
  const regex = /navigation\.(navigate|push|reset)\s*\(\s*['"](\w+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    targets.push(match[2]);
  }
  return [...new Set(targets)];
}

/**
 * Extract deep linking configuration.
 */
function extractDeepLinkConfig(source: string): Map<string, string> {
  const links = new Map<string, string>();

  // Match: config: { screens: { Home: '', Profile: 'user/:id' } }
  const configRegex = /screens\s*:\s*\{([\s\S]*?)\}/;
  const configMatch = source.match(configRegex);
  if (!configMatch) return links;

  const screenRegex = /(\w+)\s*:\s*['"]([^'"]*)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = screenRegex.exec(configMatch[1])) !== null) {
    links.set(match[1], match[2]);
  }

  return links;
}

/**
 * Detect platform-specific file from path.
 */
export function isPlatformSpecificFile(filePath: string): boolean {
  return /\.(ios|android|native|web)\.(tsx?|jsx?)$/.test(filePath);
}

/**
 * Extract platform from file path.
 */
export function getPlatform(filePath: string): string | null {
  const match = filePath.match(/\.(ios|android|native|web)\.(tsx?|jsx?)$/);
  return match ? match[1] : null;
}

/**
 * Detect NativeModules or TurboModuleRegistry usage.
 */
export function hasNativeModuleUsage(source: string): boolean {
  return /\bNativeModules\b/.test(source)
    || /\bTurboModuleRegistry\b/.test(source)
    || /\brequireNativeComponent\b/.test(source);
}

/**
 * Extract native module names from usage.
 */
export function extractNativeModuleNames(source: string): string[] {
  const modules: string[] = [];

  // NativeModules.ModuleName or const { ModuleName } = NativeModules
  const destructRegex = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*NativeModules/g;
  let match: RegExpExecArray | null;
  while ((match = destructRegex.exec(source)) !== null) {
    const names = match[1].split(',').map((n) => n.trim()).filter(Boolean);
    modules.push(...names);
  }

  const dotRegex = /NativeModules\.(\w+)/g;
  while ((match = dotRegex.exec(source)) !== null) {
    modules.push(match[1]);
  }

  // TurboModuleRegistry.getEnforcing<Spec>('ModuleName')
  const turboRegex = /TurboModuleRegistry\.(?:getEnforcing|get)\s*(?:<[^>]*>)?\s*\(\s*['"](\w+)['"]\s*\)/g;
  while ((match = turboRegex.exec(source)) !== null) {
    modules.push(match[1]);
  }

  // requireNativeComponent('ViewName')
  const nativeCompRegex = /requireNativeComponent\s*\(\s*['"](\w+)['"]\s*\)/g;
  while ((match = nativeCompRegex.exec(source)) !== null) {
    modules.push(match[1]);
  }

  return [...new Set(modules)];
}
