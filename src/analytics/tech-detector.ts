/**
 * Technology detector — parses package manifests and assesses
 * trace-mcp plugin coverage for detected dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_PACKAGES, type PackageMeta } from './known-packages.js';
import { logger } from '../logger.js';

export interface DependencyInfo {
  name: string;
  version: string;
  category: PackageMeta['category'];
  isDev: boolean;
  coveredByPlugin: string | null;
  priority: PackageMeta['priority'];
}

export interface CoverageGap {
  name: string;
  version: string;
  category: string;
  priority: 'high' | 'medium' | 'low';
  reason?: string;
}

export interface CoverageReport {
  project: string;
  manifests_analyzed: string[];
  dependencies: DependencyInfo[];
  coverage: {
    total_significant: number;
    covered: number;
    coverage_pct: number;
  };
  covered: { name: string; version: string; plugin: string }[];
  gaps: CoverageGap[];
  unknown: { name: string; version: string }[];
}

// --- Manifest parsers ---

interface RawDep {
  name: string;
  version: string;
  isDev: boolean;
}

function parsePackageJson(filePath: string): RawDep[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const deps: RawDep[] = [];
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      deps.push({ name, version: String(version), isDev: false });
    }
    for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
      deps.push({ name, version: String(version), isDev: true });
    }
    return deps;
  } catch {
    return [];
  }
}

function parseComposerJson(filePath: string): RawDep[] {
  try {
    const pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const deps: RawDep[] = [];
    for (const [name, version] of Object.entries(pkg.require ?? {})) {
      if (name === 'php' || name.startsWith('ext-')) continue;
      deps.push({ name, version: String(version), isDev: false });
    }
    for (const [name, version] of Object.entries(pkg['require-dev'] ?? {})) {
      deps.push({ name, version: String(version), isDev: true });
    }
    return deps;
  } catch {
    return [];
  }
}

function parseRequirementsTxt(filePath: string): RawDep[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const deps: RawDep[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*([><=!~]+\s*[\d.]+)?/);
      if (match) {
        deps.push({ name: match[1].toLowerCase(), version: match[2]?.trim() || '*', isDev: false });
      }
    }
    return deps;
  } catch {
    return [];
  }
}

function parsePyprojectToml(filePath: string): RawDep[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const deps: RawDep[] = [];
    // Simple TOML parsing for dependencies array
    const depSection = content.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depSection) {
      const matches = depSection[1].matchAll(/"([a-zA-Z0-9_.-]+)([^"]*)?"/g);
      for (const m of matches) {
        deps.push({ name: m[1].toLowerCase(), version: m[2]?.trim() || '*', isDev: false });
      }
    }
    return deps;
  } catch {
    return [];
  }
}

function parseGoMod(filePath: string): RawDep[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const deps: RawDep[] = [];
    const requireBlock = content.match(/require\s*\(([\s\S]*?)\)/);
    if (requireBlock) {
      for (const line of requireBlock[1].split('\n')) {
        const m = line.trim().match(/^(\S+)\s+(v[\d.]+)/);
        if (m) deps.push({ name: m[1], version: m[2], isDev: false });
      }
    }
    // Single-line requires
    const singleReqs = content.matchAll(/require\s+(\S+)\s+(v[\d.]+)/g);
    for (const m of singleReqs) {
      deps.push({ name: m[1], version: m[2], isDev: false });
    }
    return deps;
  } catch {
    return [];
  }
}

function parseGemfile(filePath: string): RawDep[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const deps: RawDep[] = [];
    for (const line of content.split('\n')) {
      const m = line.match(/gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['""])?/);
      if (m) {
        const isDev = line.includes(':development') || line.includes(':test');
        deps.push({ name: m[1], version: m[2] || '*', isDev });
      }
    }
    return deps;
  } catch {
    return [];
  }
}

// --- Manifest detection ---

const MANIFEST_PARSERS: { file: string; parser: (path: string) => RawDep[] }[] = [
  { file: 'package.json', parser: parsePackageJson },
  { file: 'composer.json', parser: parseComposerJson },
  { file: 'requirements.txt', parser: parseRequirementsTxt },
  { file: 'pyproject.toml', parser: parsePyprojectToml },
  { file: 'go.mod', parser: parseGoMod },
  { file: 'Gemfile', parser: parseGemfile },
];

// --- Main ---

/** Detect technologies and assess coverage */
export function detectCoverage(projectRoot: string, opts: { includeDev?: boolean } = {}): CoverageReport {
  const { includeDev = false } = opts;
  const manifestsFound: string[] = [];
  const allDeps: DependencyInfo[] = [];

  for (const { file, parser } of MANIFEST_PARSERS) {
    const filePath = path.join(projectRoot, file);
    if (!fs.existsSync(filePath)) continue;
    manifestsFound.push(file);

    const rawDeps = parser(filePath);
    for (const raw of rawDeps) {
      if (!includeDev && raw.isDev) continue;

      const known = KNOWN_PACKAGES[raw.name];
      allDeps.push({
        name: raw.name,
        version: raw.version,
        category: known?.category ?? 'utility',
        isDev: raw.isDev,
        coveredByPlugin: known?.plugin ?? null,
        priority: known?.priority ?? 'none',
      });
    }
  }

  // Significant = not 'none' priority
  const significant = allDeps.filter(d => d.priority !== 'none');
  const covered = significant.filter(d => d.coveredByPlugin !== null);
  const gaps = significant
    .filter(d => d.coveredByPlugin === null)
    .map(d => ({ name: d.name, version: d.version, category: d.category, priority: d.priority as 'high' | 'medium' | 'low' }))
    .sort((a, b) => {
      const prio = { high: 0, medium: 1, low: 2 };
      return (prio[a.priority] ?? 3) - (prio[b.priority] ?? 3);
    });

  const unknown = allDeps
    .filter(d => !KNOWN_PACKAGES[d.name] && d.priority === 'none')
    .map(d => ({ name: d.name, version: d.version }));

  return {
    project: projectRoot,
    manifests_analyzed: manifestsFound,
    dependencies: allDeps,
    coverage: {
      total_significant: significant.length,
      covered: covered.length,
      coverage_pct: significant.length > 0 ? Math.round(covered.length / significant.length * 100) : 100,
    },
    covered: covered.map(d => ({ name: d.name, version: d.version, plugin: d.coveredByPlugin! })),
    gaps,
    unknown,
  };
}
