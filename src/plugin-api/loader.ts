import path from 'node:path';
import { logger } from '../logger.js';
import type { FrameworkPlugin, LanguagePlugin } from './types.js';

type ExternalPlugin = LanguagePlugin | FrameworkPlugin;

/**
 * Load external plugins from file paths or npm package names.
 * - Paths starting with './' or '../' are resolved relative to rootPath.
 * - Other strings are treated as npm package names.
 * - Each module must export a default plugin object or factory function.
 */
export async function loadExternalPlugins(
  pluginPaths: string[],
  rootPath: string,
): Promise<ExternalPlugin[]> {
  const plugins: ExternalPlugin[] = [];

  for (const pluginPath of pluginPaths) {
    try {
      const resolved = isRelativePath(pluginPath) ? path.resolve(rootPath, pluginPath) : pluginPath;

      const mod = await import(resolved);
      const exported = mod.default;

      if (!exported) {
        logger.warn({ pluginPath }, 'Plugin has no default export, skipping');
        continue;
      }

      const plugin: ExternalPlugin = typeof exported === 'function' ? exported() : exported;

      if (!isValidPlugin(plugin)) {
        logger.warn(
          { pluginPath },
          'Plugin does not conform to LanguagePlugin or FrameworkPlugin interface',
        );
        continue;
      }

      plugins.push(plugin);
      logger.info({ pluginPath, name: plugin.manifest.name }, 'Loaded external plugin');
    } catch (e) {
      logger.error({ pluginPath, error: e }, 'Failed to load external plugin');
    }
  }

  return plugins;
}

function isRelativePath(p: string): boolean {
  return p.startsWith('./') || p.startsWith('../');
}

function isValidPlugin(p: unknown): p is ExternalPlugin {
  if (!p || typeof p !== 'object') return false;
  const obj = p as Record<string, unknown>;
  if (!obj.manifest || typeof obj.manifest !== 'object') return false;

  const manifest = obj.manifest as Record<string, unknown>;
  return typeof manifest.name === 'string' && typeof manifest.priority === 'number';
}
