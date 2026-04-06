/**
 * Cross-repo package dependency analysis.
 *
 * Scans package.json / composer.json / pyproject.toml across registered projects
 * in ~/.trace-mcp/registry.json to build a package-level dependency graph.
 *
 * Single-pass per repo: reads manifest once, extracts all deps. No N+1.
 */

import fs from 'node:fs';
import path from 'node:path';
import { REGISTRY_PATH } from '../../global.js';

interface PackageInfo {
  name: string;
  version?: string;
  repo: string;
  repoPath: string;
}

interface DepRelation {
  package: string;
  repo: string;
  repoPath: string;
  importCount: number;
  depType: 'dependencies' | 'devDependencies' | 'require' | 'require-dev';
}

interface PackageDepsResult {
  package?: string;
  project?: string;
  direction: string;
  results: DepRelation[];
  published_packages: PackageInfo[];
}

interface RegistryEntry {
  name: string;
  path: string;
  publishes?: string[];
}

/** Load project registry from ~/.trace-mcp/registry.json */
function loadRegistry(): Record<string, RegistryEntry> {
  if (!fs.existsSync(REGISTRY_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    return raw.projects ?? raw ?? {};
  } catch {
    return {};
  }
}

/** Read package manifest (package.json, composer.json) from a repo */
function readManifest(repoPath: string): {
  name?: string;
  deps: Map<string, { version: string; type: string }>;
  publishes: string[];
} {
  const result = { name: undefined as string | undefined, deps: new Map<string, { version: string; type: string }>(), publishes: [] as string[] };

  // package.json (npm)
  const pkgJsonPath = path.join(repoPath, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      result.name = pkg.name;
      if (pkg.name) result.publishes.push(pkg.name);
      for (const [dep, ver] of Object.entries(pkg.dependencies ?? {})) {
        result.deps.set(dep, { version: ver as string, type: 'dependencies' });
      }
      for (const [dep, ver] of Object.entries(pkg.devDependencies ?? {})) {
        result.deps.set(dep, { version: ver as string, type: 'devDependencies' });
      }
    } catch { /* ignore */ }
  }

  // composer.json (PHP)
  const composerPath = path.join(repoPath, 'composer.json');
  if (fs.existsSync(composerPath)) {
    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf-8'));
      if (composer.name) {
        result.name ??= composer.name;
        result.publishes.push(composer.name);
      }
      for (const [dep, ver] of Object.entries(composer.require ?? {})) {
        if (dep === 'php') continue;
        result.deps.set(dep, { version: ver as string, type: 'require' });
      }
      for (const [dep, ver] of Object.entries(composer['require-dev'] ?? {})) {
        result.deps.set(dep, { version: ver as string, type: 'require-dev' });
      }
    } catch { /* ignore */ }
  }

  // pyproject.toml (Python) — simple key extraction
  const pyprojectPath = path.join(repoPath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    try {
      const content = fs.readFileSync(pyprojectPath, 'utf-8');
      const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) {
        result.name ??= nameMatch[1];
        result.publishes.push(nameMatch[1]);
      }
      // Extract dependencies list
      const depsSection = content.match(/\[project\]\s*[\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
      if (depsSection) {
        const depMatches = depsSection[1].matchAll(/"([a-zA-Z0-9_-]+)/g);
        for (const m of depMatches) {
          result.deps.set(m[1], { version: '*', type: 'dependencies' });
        }
      }
    } catch { /* ignore */ }
  }

  return result;
}

export function getPackageDeps(options: {
  package?: string;
  project?: string;
  direction: 'dependents' | 'dependencies' | 'both';
}): PackageDepsResult {
  const { package: pkg, project, direction } = options;
  const registry = loadRegistry();

  // Build full picture: scan all repos once (no N+1)
  const repoManifests = new Map<string, ReturnType<typeof readManifest>>();
  const publishMap = new Map<string, { repo: string; repoPath: string }>(); // package name → repo

  for (const [repoPath, entry] of Object.entries(registry)) {
    const absPath = repoPath;
    if (!fs.existsSync(absPath)) continue;

    const manifest = readManifest(absPath);
    repoManifests.set(repoPath, manifest);

    // Register published packages
    const allPublishes = [...(entry.publishes ?? []), ...manifest.publishes];
    for (const p of new Set(allPublishes)) {
      publishMap.set(p, { repo: entry.name ?? path.basename(repoPath), repoPath });
    }
  }

  const results: DepRelation[] = [];
  const targetPackages = new Set<string>();

  // Determine target packages
  if (pkg) {
    targetPackages.add(pkg);
  } else if (project) {
    // Find all packages published by this project
    for (const [repoPath, manifest] of repoManifests) {
      const entry = registry[repoPath];
      if (entry?.name === project || path.basename(repoPath) === project) {
        for (const p of manifest.publishes) {
          targetPackages.add(p);
        }
      }
    }
  }

  if (targetPackages.size === 0 && (pkg || project)) {
    return {
      package: pkg,
      project,
      direction,
      results: [],
      published_packages: [],
    };
  }

  // Find dependents (who uses these packages)
  if (direction === 'dependents' || direction === 'both') {
    for (const [repoPath, manifest] of repoManifests) {
      const entry = registry[repoPath];
      const repoName = entry?.name ?? path.basename(repoPath);

      for (const targetPkg of targetPackages) {
        const dep = manifest.deps.get(targetPkg);
        if (dep) {
          results.push({
            package: targetPkg,
            repo: repoName,
            repoPath,
            importCount: 1, // manifest-level, not import-level
            depType: dep.type as DepRelation['depType'],
          });
        }
      }
    }
  }

  // Find dependencies (what these packages depend on)
  if (direction === 'dependencies' || direction === 'both') {
    for (const [repoPath, manifest] of repoManifests) {
      const entry = registry[repoPath];
      const repoName = entry?.name ?? path.basename(repoPath);

      // Only from repos that publish our target packages
      const isTarget = manifest.publishes.some((p) => targetPackages.has(p));
      if (!isTarget && targetPackages.size > 0) continue;

      for (const [dep, info] of manifest.deps) {
        // Check if this dep is published by another registered repo
        const publisher = publishMap.get(dep);
        if (publisher && publisher.repoPath !== repoPath) {
          results.push({
            package: dep,
            repo: repoName,
            repoPath: publisher.repoPath,
            importCount: 1,
            depType: info.type as DepRelation['depType'],
          });
        }
      }
    }
  }

  // Collect published packages info
  const publishedPackages: PackageInfo[] = [];
  for (const [pkgName, info] of publishMap) {
    if (targetPackages.size === 0 || targetPackages.has(pkgName)) {
      publishedPackages.push({
        name: pkgName,
        repo: info.repo,
        repoPath: info.repoPath,
      });
    }
  }

  return {
    package: pkg,
    project,
    direction,
    results,
    published_packages: publishedPackages,
  };
}
