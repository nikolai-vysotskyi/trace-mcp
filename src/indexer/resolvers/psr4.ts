/**
 * PSR-4 Autoload Resolver.
 *
 * Resolves PHP FQN ↔ file paths based on composer.json autoload mappings.
 */
import { readFileSync } from 'node:fs';

export class Psr4Resolver {
  /** namespace prefix (with trailing backslash) → directory (with trailing slash) */
  private mappings: Map<string, string>;

  constructor(
    mappings: Map<string, string>,
    private rootPath: string,
  ) {
    // Normalise: ensure prefix ends with \ and dir ends with /
    this.mappings = new Map();
    for (const [prefix, dir] of mappings) {
      const normPrefix = prefix.endsWith('\\') ? prefix : `${prefix}\\`;
      const normDir = dir.endsWith('/') ? dir : `${dir}/`;
      this.mappings.set(normPrefix, normDir);
    }
  }

  /**
   * Create a Psr4Resolver from a composer.json file.
   * Reads both autoload.psr-4 and autoload-dev.psr-4 sections.
   */
  static fromComposerJson(composerJsonPath: string, rootPath: string): Psr4Resolver | undefined {
    try {
      const raw = readFileSync(composerJsonPath, 'utf-8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      const mappings = new Map<string, string>();

      const extractPsr4 = (section: unknown): void => {
        if (section && typeof section === 'object' && !Array.isArray(section)) {
          const psr4 = (section as Record<string, unknown>)['psr-4'];
          if (psr4 && typeof psr4 === 'object' && !Array.isArray(psr4)) {
            for (const [prefix, dir] of Object.entries(psr4 as Record<string, unknown>)) {
              if (typeof dir === 'string') {
                mappings.set(prefix, dir);
              }
              // Handle array of directories (rare but valid in composer)
              if (Array.isArray(dir)) {
                for (const d of dir) {
                  if (typeof d === 'string') {
                    mappings.set(prefix, d);
                  }
                }
              }
            }
          }
        }
      };

      extractPsr4(json['autoload']);
      extractPsr4(json['autoload-dev']);

      if (mappings.size === 0) return undefined;
      return new Psr4Resolver(mappings, rootPath);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve a fully qualified class name to a relative file path.
   * Matches the longest prefix first.
   *
   * Example: "App\Models\User" → "app/Models/User.php"
   */
  resolve(fqn: string): string | undefined {
    let bestPrefix = '';
    let bestDir = '';

    for (const [prefix, dir] of this.mappings) {
      if (fqn.startsWith(prefix) && prefix.length > bestPrefix.length) {
        bestPrefix = prefix;
        bestDir = dir;
      }
      // Also match exact class name (prefix without trailing \)
      const prefixNoSlash = prefix.slice(0, -1);
      if (fqn === prefixNoSlash && prefix.length > bestPrefix.length) {
        bestPrefix = prefix;
        bestDir = dir;
      }
    }

    if (!bestPrefix) return undefined;

    const remainder = fqn.substring(bestPrefix.length);
    const relativePath = remainder.replace(/\\/g, '/');
    return `${bestDir + relativePath}.php`;
  }

  /**
   * Reverse-resolve a relative file path to a fully qualified class name.
   *
   * Example: "app/Models/User.php" → "App\Models\User"
   */
  resolveToFqn(filePath: string): string | undefined {
    // Normalise the file path to use forward slashes and be relative
    let normalised = filePath.replace(/\\/g, '/');
    // Strip rootPath prefix if present
    const rootNorm = `${this.rootPath.replace(/\\/g, '/').replace(/\/$/, '')}/`;
    if (normalised.startsWith(rootNorm)) {
      normalised = normalised.substring(rootNorm.length);
    }

    // Must be a .php file
    if (!normalised.endsWith('.php')) return undefined;
    const withoutExt = normalised.slice(0, -4); // strip .php

    let bestPrefix = '';
    let bestDir = '';

    for (const [prefix, dir] of this.mappings) {
      if (withoutExt.startsWith(dir) && dir.length > bestDir.length) {
        bestPrefix = prefix;
        bestDir = dir;
      }
      // Handle case where dir has no trailing slash yet
      const dirNoSlash = dir.replace(/\/$/, '');
      if (withoutExt.startsWith(`${dirNoSlash}/`) && dir.length > bestDir.length) {
        bestPrefix = prefix;
        bestDir = dir;
      }
    }

    if (!bestDir) return undefined;

    const remainder = withoutExt.substring(bestDir.length);
    const fqnSuffix = remainder.replace(/\//g, '\\');
    return bestPrefix + fqnSuffix;
  }

  /** Get all registered mappings (for debugging / inspection). */
  getMappings(): ReadonlyMap<string, string> {
    return this.mappings;
  }
}
