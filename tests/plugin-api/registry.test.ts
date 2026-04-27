import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../../src/plugin-api/registry.js';
import type {
  LanguagePlugin,
  FrameworkPlugin,
  ProjectContext,
  FileParseResult,
} from '../../src/plugin-api/types.js';
import { ok } from '../../src/errors.js';

function makeLanguagePlugin(name: string, priority: number, extensions: string[]): LanguagePlugin {
  return {
    manifest: { name, version: '1.0.0', priority },
    supportedExtensions: extensions,
    extractSymbols: () => ok({ status: 'ok', symbols: [] } as FileParseResult),
  };
}

function makeFrameworkPlugin(
  name: string,
  priority: number,
  deps: string[] = [],
  detect = true,
): FrameworkPlugin {
  return {
    manifest: { name, version: '1.0.0', priority, dependencies: deps },
    detect: () => detect,
    registerSchema: () => ({}),
  };
}

const mockCtx: ProjectContext = {
  rootPath: '/tmp/test',
  configFiles: [],
};

describe('plugin registry', () => {
  it('sorts language plugins by priority', () => {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(makeLanguagePlugin('vue', 10, ['.vue']));
    registry.registerLanguagePlugin(makeLanguagePlugin('php', 0, ['.php']));
    registry.registerLanguagePlugin(makeLanguagePlugin('ts', 5, ['.ts']));

    const plugins = registry.getLanguagePlugins();
    expect(plugins.map((p) => p.manifest.name)).toEqual(['php', 'ts', 'vue']);
  });

  it('finds language plugin by file extension', () => {
    const registry = new PluginRegistry();
    registry.registerLanguagePlugin(makeLanguagePlugin('php', 0, ['.php']));
    registry.registerLanguagePlugin(makeLanguagePlugin('ts', 5, ['.ts', '.tsx']));

    expect(registry.getLanguagePluginForFile('app/Models/User.php')?.manifest.name).toBe('php');
    expect(registry.getLanguagePluginForFile('src/App.tsx')?.manifest.name).toBe('ts');
    expect(registry.getLanguagePluginForFile('readme.md')).toBeUndefined();
  });

  it('topological sorts framework plugins by dependencies', () => {
    const registry = new PluginRegistry();
    registry.registerFrameworkPlugin(
      makeFrameworkPlugin('inertia', 20, ['laravel', 'vue-framework']),
    );
    registry.registerFrameworkPlugin(makeFrameworkPlugin('vue-framework', 10));
    registry.registerFrameworkPlugin(makeFrameworkPlugin('laravel', 0));

    const result = registry.getActiveFrameworkPlugins(mockCtx);
    expect(result.isOk()).toBe(true);

    const names = result._unsafeUnwrap().map((p) => p.manifest.name);
    expect(names.indexOf('laravel')).toBeLessThan(names.indexOf('inertia'));
    expect(names.indexOf('vue-framework')).toBeLessThan(names.indexOf('inertia'));
  });

  it('detects circular dependencies', () => {
    const registry = new PluginRegistry();
    registry.registerFrameworkPlugin(makeFrameworkPlugin('a', 0, ['b']));
    registry.registerFrameworkPlugin(makeFrameworkPlugin('b', 0, ['a']));

    const result = registry.getActiveFrameworkPlugins(mockCtx);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('PLUGIN_ERROR');
  });

  it('filters inactive framework plugins', () => {
    const registry = new PluginRegistry();
    registry.registerFrameworkPlugin(makeFrameworkPlugin('laravel', 0, [], true));
    registry.registerFrameworkPlugin(makeFrameworkPlugin('nuxt', 10, [], false));

    const result = registry.getActiveFrameworkPlugins(mockCtx);
    expect(result.isOk()).toBe(true);

    const names = result._unsafeUnwrap().map((p) => p.manifest.name);
    expect(names).toEqual(['laravel']);
  });

  it('handles missing dependency in active set gracefully', () => {
    const registry = new PluginRegistry();
    // inertia depends on laravel, but laravel is not active (detect=false)
    registry.registerFrameworkPlugin(makeFrameworkPlugin('inertia', 10, ['laravel']));
    registry.registerFrameworkPlugin(makeFrameworkPlugin('laravel', 0, [], false));

    const result = registry.getActiveFrameworkPlugins(mockCtx);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().map((p) => p.manifest.name)).toEqual(['inertia']);
  });
});
