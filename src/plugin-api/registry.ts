import { err, ok, pluginError, type TraceMcpResult } from '../errors.js';
import { createAllIntegrationPlugins } from '../indexer/plugins/integration/all.js';
import { createAllLanguagePlugins } from '../indexer/plugins/language/all.js';
import type { FrameworkPlugin, LanguagePlugin, PluginManifest, ProjectContext } from './types.js';

/**
 * Map a shebang interpreter name to the file extension whose plugin handles
 * the same language. Keeping this as an extension lookup means new languages
 * (or plugin renames) keep working with shebangs automatically.
 */
const SHEBANG_TO_EXT: Readonly<Record<string, string>> = Object.freeze({
  python: '.py',
  python2: '.py',
  python3: '.py',
  bash: '.sh',
  sh: '.sh',
  zsh: '.sh',
  ksh: '.sh',
  dash: '.sh',
  ash: '.sh',
  node: '.js',
  nodejs: '.js',
  deno: '.ts',
  bun: '.ts',
  ruby: '.rb',
  perl: '.pl',
  php: '.php',
  lua: '.lua',
  luau: '.luau',
  tclsh: '.tcl',
  wish: '.tcl',
  fish: '.sh',
  pwsh: '.ps1',
  powershell: '.ps1',
  rscript: '.R',
  julia: '.jl',
  groovy: '.groovy',
});

export class PluginRegistry {
  private languagePlugins: LanguagePlugin[] = [];
  private frameworkPlugins: FrameworkPlugin[] = [];
  // O(1) extension → plugin lookup (built lazily on first query)
  private _extMap: Map<string, LanguagePlugin> | undefined;
  // Cached framework detection results (invalidated by clearCaches)
  private _activeFrameworkCache: TraceMcpResult<FrameworkPlugin[]> | undefined;

  registerLanguagePlugin(plugin: LanguagePlugin): void {
    this.languagePlugins.push(plugin);
    this._extMap = undefined; // invalidate cache
  }

  registerFrameworkPlugin(plugin: FrameworkPlugin): void {
    this.frameworkPlugins.push(plugin);
  }

  /** Register the full set of built-in language and framework plugins. */
  registerDefaults(): void {
    for (const p of createAllLanguagePlugins()) this.registerLanguagePlugin(p);
    for (const p of createAllIntegrationPlugins()) this.registerFrameworkPlugin(p);
  }

  static createWithDefaults(): PluginRegistry {
    const registry = new PluginRegistry();
    registry.registerDefaults();
    return registry;
  }

  getLanguagePlugins(): LanguagePlugin[] {
    return this.sortByPriority(this.languagePlugins);
  }

  getActiveFrameworkPlugins(ctx: ProjectContext): TraceMcpResult<FrameworkPlugin[]> {
    if (this._activeFrameworkCache) return this._activeFrameworkCache;
    const active = this.frameworkPlugins.filter((p) => p.detect(ctx));
    this._activeFrameworkCache = this.topologicalSort(active);
    return this._activeFrameworkCache;
  }

  /** Clear per-pipeline-run caches. Call at start of each indexing run. */
  clearCaches(): void {
    this._activeFrameworkCache = undefined;
  }

  getAllFrameworkPlugins(): FrameworkPlugin[] {
    return [...this.frameworkPlugins];
  }

  getLanguagePluginForFile(filePath: string): LanguagePlugin | undefined {
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    return this.getExtensionMap().get(ext);
  }

  /**
   * Resolve a language plugin from a `#!` shebang on the first line.
   * graphify v0.6.2 added the same fallback so extensionless scripts
   * (`bin/deploy`, `scripts/migrate`, etc.) actually get indexed instead
   * of dropping out silently. We map the interpreter to the existing
   * extension-based plugin lookup — so adding `.py` to a plugin
   * automatically enables it for Python shebangs too.
   */
  getLanguagePluginByShebang(firstBytes: Buffer | string): LanguagePlugin | undefined {
    const head = typeof firstBytes === 'string' ? firstBytes : firstBytes.toString('utf-8', 0, 200);
    if (!head.startsWith('#!')) return undefined;
    const eol = head.indexOf('\n');
    const line = (eol >= 0 ? head.slice(0, eol) : head).toLowerCase();

    // Take the component after the last slash, then split into tokens.
    // For `#!/usr/bin/env python3 -u` the last slash sits after `/usr/bin`,
    // so tail is `env python3 -u`. For `#!/bin/bash` it is just `bash`.
    const lastSlash = line.lastIndexOf('/');
    const tail = (lastSlash >= 0 ? line.slice(lastSlash + 1) : line.slice(2)).trim();
    const tokens = tail.split(/\s+/).filter(Boolean);

    // Skip `env` and any of its flags (`-S`, `--split-string`, `KEY=val` env-vars)
    // until we hit the actual interpreter name.
    let i = 0;
    if (tokens[i] === 'env') {
      i++;
      while (i < tokens.length) {
        const t = tokens[i];
        if (t.startsWith('-') || /^[A-Z_][A-Z0-9_]*=/i.test(t)) {
          i++;
        } else break;
      }
    }
    const interpreter = tokens[i];
    if (!interpreter) return undefined;
    const ext = SHEBANG_TO_EXT[interpreter];
    if (!ext) return undefined;
    return this.getExtensionMap().get(ext);
  }

  /**
   * Convenience that combines extension lookup with a shebang fallback.
   * Falls back to shebang only when the extension lookup fails — keeps
   * the fast path identical for the 99% of files with a normal extension.
   */
  getLanguagePluginForFileWithFallback(
    filePath: string,
    firstBytes?: Buffer | string,
  ): LanguagePlugin | undefined {
    const direct = this.getLanguagePluginForFile(filePath);
    if (direct) return direct;
    if (firstBytes === undefined) return undefined;
    return this.getLanguagePluginByShebang(firstBytes);
  }

  private getExtensionMap(): Map<string, LanguagePlugin> {
    if (this._extMap) return this._extMap;
    this._extMap = new Map();
    // Lower priority number = higher priority → process in reverse so higher priority wins
    const sorted = this.getLanguagePlugins().reverse();
    for (const plugin of sorted) {
      for (const ext of plugin.supportedExtensions) {
        this._extMap.set(ext, plugin);
      }
    }
    return this._extMap;
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
        return err(pluginError(name, `Circular dependency detected involving plugin '${name}'`));
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
