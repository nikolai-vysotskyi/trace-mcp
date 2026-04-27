/**
 * ES Module Resolver — uses oxc-resolver to resolve import specifiers
 * following Node.js / TypeScript resolution rules.
 *
 * Workspace-aware: creates a separate resolver per workspace root so that
 * each sub-project gets its own tsconfig paths / aliases.  Automatically
 * detects Nuxt/Vite `~` and `@` aliases when tsconfig is unavailable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ResolverFactory } from 'oxc-resolver';
import type { NapiResolveOptions, TsconfigOptions } from 'oxc-resolver';
import { logger } from '../../logger.js';

/** Detect the Nuxt `srcDir` for a given project root (defaults to `app/` or `.`). */
function detectNuxtSrcDir(projectRoot: string): string | null {
  const nuxtConfigs = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'];
  const hasNuxt = nuxtConfigs.some((f) => fs.existsSync(path.join(projectRoot, f)));
  if (!hasNuxt) return null;

  // Nuxt 3 default srcDir is `app/` if it exists, otherwise `.`
  if (fs.existsSync(path.join(projectRoot, 'app'))) return path.join(projectRoot, 'app');
  return projectRoot;
}

/** Detect Vite `@` alias (common convention: `@` → `src/`). */
function detectViteSrcDir(projectRoot: string): string | null {
  const viteConfigs = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];
  const hasVite = viteConfigs.some((f) => fs.existsSync(path.join(projectRoot, f)));
  if (!hasVite) return null;

  if (fs.existsSync(path.join(projectRoot, 'src'))) return path.join(projectRoot, 'src');
  return null;
}

/** Try to find the nearest valid tsconfig.json or jsconfig.json (Next.js JS projects). */
function findTsconfig(startDir: string, stopDir: string): string | undefined {
  let dir = startDir;
  while (dir.startsWith(stopDir)) {
    // Check tsconfig.json first, then jsconfig.json (Next.js pure JS convention)
    for (const fileName of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = path.join(dir, fileName);
      if (!fs.existsSync(candidate)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { extends?: string };
        if (raw.extends) {
          const extendsPath = path.resolve(path.dirname(candidate), raw.extends);
          if (!fs.existsSync(extendsPath)) {
            logger.debug(
              { tsconfig: candidate, extends: raw.extends },
              'Skipping tsconfig with missing extends',
            );
            continue;
          }
        }
        return candidate;
      } catch {
        // JSON parse error — skip this tsconfig
        continue;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return undefined;
}

function buildResolver(projectRoot: string, rootPath: string): ResolverFactory {
  const options: NapiResolveOptions = {
    conditionNames: ['import', 'require', 'node', 'default'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte'],
    mainFields: ['module', 'main'],
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    },
  };

  // Find nearest valid tsconfig
  const tsconfigPath = findTsconfig(projectRoot, rootPath);
  if (tsconfigPath) {
    const tsconfig: TsconfigOptions = { configFile: tsconfigPath };
    options.tsconfig = tsconfig;
  }

  // Auto-detect framework aliases as fallbacks
  const alias: Record<string, string[]> = {};

  const nuxtSrcDir = detectNuxtSrcDir(projectRoot);
  if (nuxtSrcDir) {
    // Nuxt uses ~ and ~/* for srcDir, and @ and @/* for srcDir
    alias['~'] = [nuxtSrcDir];
    alias['~/*'] = [path.join(nuxtSrcDir, '*')];
    alias['@'] = [nuxtSrcDir];
    alias['@/*'] = [path.join(nuxtSrcDir, '*')];
    logger.debug({ projectRoot, srcDir: nuxtSrcDir }, 'Nuxt alias detected: ~ and @ → srcDir');
  } else {
    const viteSrcDir = detectViteSrcDir(projectRoot);
    if (viteSrcDir) {
      alias['@'] = [viteSrcDir];
      alias['@/*'] = [path.join(viteSrcDir, '*')];
      logger.debug({ projectRoot, srcDir: viteSrcDir }, 'Vite alias detected: @ → src/');
    }
  }

  if (Object.keys(alias).length > 0) {
    options.alias = alias;
  }

  return new ResolverFactory(options);
}

export interface WorkspaceResolver {
  /** The workspace root path (absolute). */
  workspaceRoot: string;
  /** The oxc-resolver instance. */
  resolver: ResolverFactory;
}

export class EsModuleResolver {
  private resolvers: Map<string, ResolverFactory> = new Map();
  private rootResolver: ResolverFactory;
  /** Workspace paths sorted longest-first for prefix matching. */
  private sortedWorkspacePaths: string[] = [];

  constructor(rootPath: string, workspacePaths?: string[]) {
    this.rootPath = rootPath;

    // Build resolvers for each workspace
    if (workspacePaths && workspacePaths.length > 0) {
      // Sort longest-first so nested workspaces match before parents
      this.sortedWorkspacePaths = [...workspacePaths]
        .map((wp) => (path.isAbsolute(wp) ? wp : path.resolve(rootPath, wp)))
        .sort((a, b) => b.length - a.length);

      for (const absWsPath of this.sortedWorkspacePaths) {
        try {
          this.resolvers.set(absWsPath, buildResolver(absWsPath, rootPath));
        } catch (e) {
          logger.warn(
            { workspace: absWsPath, error: e },
            'Failed to create resolver for workspace',
          );
        }
      }
    }

    // Root resolver as fallback
    try {
      this.rootResolver = buildResolver(rootPath, rootPath);
    } catch {
      // Bare minimum resolver
      this.rootResolver = new ResolverFactory({
        conditionNames: ['import', 'require', 'node', 'default'],
        extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.vue', '.svelte'],
        mainFields: ['module', 'main'],
      });
    }
  }

  /** Get the resolver for the workspace containing `absFilePath`. */
  private getResolver(absFilePath: string): ResolverFactory {
    for (const wsPath of this.sortedWorkspacePaths) {
      if (absFilePath.startsWith(wsPath + '/') || absFilePath === wsPath) {
        const resolver = this.resolvers.get(wsPath);
        if (resolver) return resolver;
      }
    }
    return this.rootResolver;
  }

  /** Resolve a specifier from a given source file. Returns the absolute path or undefined. */
  resolve(specifier: string, fromFile: string): string | undefined {
    const resolver = this.getResolver(fromFile);
    const result = resolver.sync(path.dirname(fromFile), specifier);
    if (result.path) return result.path;

    // Fallback to root resolver if workspace resolver failed
    if (resolver !== this.rootResolver) {
      const fallback = this.rootResolver.sync(path.dirname(fromFile), specifier);
      return fallback.path ?? undefined;
    }

    return undefined;
  }
}
