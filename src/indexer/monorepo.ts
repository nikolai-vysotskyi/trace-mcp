import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import fg from 'fast-glob';
import { logger } from '../logger.js';

export interface WorkspaceInfo {
  name: string;
  path: string; // relative to root
}

/**
 * Detect monorepo workspaces from pnpm-workspace.yaml, package.json, or composer.json.
 * Returns an empty array if no workspace config is found.
 */
export function detectWorkspaces(rootPath: string): WorkspaceInfo[] {
  // 1. pnpm-workspace.yaml
  const pnpmResult = detectPnpmWorkspaces(rootPath);
  if (pnpmResult.length > 0) return pnpmResult;

  // 2. package.json workspaces (npm/yarn)
  const npmResult = detectNpmWorkspaces(rootPath);
  if (npmResult.length > 0) return npmResult;

  // 3. composer.json path repositories
  const composerResult = detectComposerWorkspaces(rootPath);
  if (composerResult.length > 0) return composerResult;

  return [];
}

/**
 * Build workspace list for a multi-root project.
 * Each child root becomes a top-level workspace. Sub-workspaces within
 * each child (pnpm, npm, composer) get compound names: "child/sub-ws".
 */
export function buildMultiRootWorkspaces(parentDir: string, childRoots: string[]): WorkspaceInfo[] {
  const workspaces: WorkspaceInfo[] = [];

  for (const childRoot of childRoots) {
    const relPath = path.relative(parentDir, childRoot).replace(/\\/g, '/');
    const childName = path.basename(childRoot);

    // The child itself is a workspace
    workspaces.push({ name: childName, path: relPath });

    // Detect sub-workspaces within the child (monorepo support)
    const subWorkspaces = detectWorkspaces(childRoot);
    for (const sub of subWorkspaces) {
      workspaces.push({
        name: `${childName}/${sub.name}`,
        path: `${relPath}/${sub.path}`,
      });
    }
  }

  return workspaces;
}

function detectPnpmWorkspaces(rootPath: string): WorkspaceInfo[] {
  const yamlPath = path.join(rootPath, 'pnpm-workspace.yaml');
  if (!fs.existsSync(yamlPath)) return [];

  try {
    const content = fs.readFileSync(yamlPath, 'utf-8');
    const parsed = parseYaml(content) as { packages?: string[] } | null;
    if (!parsed?.packages?.length) return [];

    return expandGlobPatterns(rootPath, parsed.packages);
  } catch (e) {
    logger.warn({ error: e }, 'Failed to parse pnpm-workspace.yaml');
    return [];
  }
}

function detectNpmWorkspaces(rootPath: string): WorkspaceInfo[] {
  const pkgPath = path.join(rootPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];

  try {
    const content = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(content) as { workspaces?: string[] | { packages?: string[] } };

    let patterns: string[] | undefined;
    if (Array.isArray(pkg.workspaces)) {
      patterns = pkg.workspaces;
    } else if (pkg.workspaces?.packages) {
      patterns = pkg.workspaces.packages;
    }

    if (!patterns?.length) return [];
    return expandGlobPatterns(rootPath, patterns);
  } catch (e) {
    logger.warn({ error: e }, 'Failed to parse package.json workspaces');
    return [];
  }
}

function detectComposerWorkspaces(rootPath: string): WorkspaceInfo[] {
  const composerPath = path.join(rootPath, 'composer.json');
  if (!fs.existsSync(composerPath)) return [];

  try {
    const content = fs.readFileSync(composerPath, 'utf-8');
    const composer = JSON.parse(content) as {
      repositories?: Array<{ type?: string; url?: string }>;
    };

    if (!composer.repositories?.length) return [];

    const pathRepos = composer.repositories.filter((r) => r.type === 'path' && r.url);
    if (pathRepos.length === 0) return [];

    const patterns = pathRepos.map((r) => r.url!);
    return expandGlobPatterns(rootPath, patterns);
  } catch (e) {
    logger.warn({ error: e }, 'Failed to parse composer.json repositories');
    return [];
  }
}

function expandGlobPatterns(rootPath: string, patterns: string[]): WorkspaceInfo[] {
  const workspaces: WorkspaceInfo[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    // Filter out negated patterns
    if (pattern.startsWith('!')) continue;

    const matches = fg.sync(pattern, {
      cwd: rootPath,
      onlyDirectories: true,
      absolute: false,
    });

    for (const match of matches) {
      const relPath = match.replace(/\\/g, '/');
      if (seen.has(relPath)) continue;

      // Must have a package.json or composer.json to be a valid workspace
      const hasPackageJson = fs.existsSync(path.join(rootPath, relPath, 'package.json'));
      const hasComposerJson = fs.existsSync(path.join(rootPath, relPath, 'composer.json'));

      if (!hasPackageJson && !hasComposerJson) continue;

      // Derive name from package.json/composer.json
      const name = resolveWorkspaceName(rootPath, relPath);
      seen.add(relPath);
      workspaces.push({ name, path: relPath });
    }
  }

  return workspaces;
}

function resolveWorkspaceName(rootPath: string, relPath: string): string {
  // Try package.json name
  try {
    const pkgPath = path.join(rootPath, relPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { name?: string };
      if (pkg.name) return pkg.name;
    }
  } catch { /* ignore */ }

  // Try composer.json name
  try {
    const composerPath = path.join(rootPath, relPath, 'composer.json');
    if (fs.existsSync(composerPath)) {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8')) as { name?: string };
      if (composer.name) return composer.name;
    }
  } catch { /* ignore */ }

  // Fallback to directory name
  return path.basename(relPath);
}
