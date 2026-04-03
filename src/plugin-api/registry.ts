import type { LanguagePlugin, FrameworkPlugin, PluginManifest, ProjectContext } from './types.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { pluginError } from '../errors.js';

export class PluginRegistry {
  private languagePlugins: LanguagePlugin[] = [];
  private frameworkPlugins: FrameworkPlugin[] = [];

  registerLanguagePlugin(plugin: LanguagePlugin): void {
    this.languagePlugins.push(plugin);
  }

  registerFrameworkPlugin(plugin: FrameworkPlugin): void {
    this.frameworkPlugins.push(plugin);
  }

  getLanguagePlugins(): LanguagePlugin[] {
    return this.sortByPriority(this.languagePlugins);
  }

  getActiveFrameworkPlugins(ctx: ProjectContext): TraceMcpResult<FrameworkPlugin[]> {
    const active = this.frameworkPlugins.filter((p) => p.detect(ctx));
    return this.topologicalSort(active);
  }

  getAllFrameworkPlugins(): FrameworkPlugin[] {
    return [...this.frameworkPlugins];
  }

  getLanguagePluginForFile(filePath: string): LanguagePlugin | undefined {
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    const sorted = this.getLanguagePlugins();
    return sorted.find((p) => p.supportedExtensions.includes(ext));
  }

  private sortByPriority<T extends { manifest: PluginManifest }>(plugins: T[]): T[] {
    return [...plugins].sort((a, b) => a.manifest.priority - b.manifest.priority);
  }

  private topologicalSort(plugins: FrameworkPlugin[]): TraceMcpResult<FrameworkPlugin[]> {
    const nameMap = new Map<string, FrameworkPlugin>();
    for (const p of plugins) {
      nameMap.set(p.manifest.name, p);
    }

    const sorted: FrameworkPlugin[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (plugin: FrameworkPlugin): TraceMcpResult<void> => {
      const name = plugin.manifest.name;

      if (visiting.has(name)) {
        return err(
          pluginError(name, `Circular dependency detected involving plugin '${name}'`),
        );
      }

      if (visited.has(name)) return ok(undefined);

      visiting.add(name);

      for (const depName of plugin.manifest.dependencies ?? []) {
        const dep = nameMap.get(depName);
        if (dep) {
          const result = visit(dep);
          if (result.isErr()) return result;
        }
        // Missing dependency in active set is not an error — it may not be detected
      }

      visiting.delete(name);
      visited.add(name);
      sorted.push(plugin);

      return ok(undefined);
    };

    // Sort by priority first, then topological sort
    const prioritySorted = this.sortByPriority(plugins);
    for (const plugin of prioritySorted) {
      const result = visit(plugin);
      if (result.isErr()) return err(result.error);
    }

    return ok(sorted);
  }
}
