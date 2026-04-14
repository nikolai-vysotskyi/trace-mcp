/**
 * Technology detector — parses package manifests and assesses
 * trace-mcp plugin coverage for detected dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_PACKAGES, type PackageMeta } from './known-packages.js';
import { logger } from '../logger.js';
import { discoverChildProjectsRecursive } from '../project-root.js';

interface DependencyInfo {
  name: string;
  version: string;
  category: PackageMeta['category'];
  isDev: boolean;
  coveredByPlugin: string | null;
  priority: PackageMeta['priority'];
  ecosystem: Ecosystem;
}

interface CoverageGap {
  name: string;
  version: string;
  category: string;
  priority: 'high' | 'medium' | 'low';
  reason?: string;
}

type Ecosystem = 'npm' | 'composer' | 'pip' | 'go' | 'gem' | 'maven';

interface UnknownPackage {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  language_fallback: boolean;   // true = language plugin indexes this code anyway
  needs_plugin: 'likely' | 'maybe' | 'no';  // heuristic: should we add a dedicated plugin?
  reason: string;               // human-readable explanation
}

interface CoverageReport {
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
  unknown: UnknownPackage[];
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

const MANIFEST_PARSERS: { file: string; ecosystem: Ecosystem; parser: (path: string) => RawDep[] }[] = [
  { file: 'package.json', ecosystem: 'npm', parser: parsePackageJson },
  { file: 'composer.json', ecosystem: 'composer', parser: parseComposerJson },
  { file: 'requirements.txt', ecosystem: 'pip', parser: parseRequirementsTxt },
  { file: 'pyproject.toml', ecosystem: 'pip', parser: parsePyprojectToml },
  { file: 'go.mod', ecosystem: 'go', parser: parseGoMod },
  { file: 'Gemfile', ecosystem: 'gem', parser: parseGemfile },
];

// --- Unknown package heuristics ---

/** All ecosystems have language-level indexing — trace-mcp always parses source code by language */
const LANGUAGE_FALLBACK_LANGUAGES: Record<Ecosystem, string> = {
  npm: 'TypeScript/JavaScript',
  composer: 'PHP',
  pip: 'Python',
  go: 'Go',
  gem: 'Ruby',
  maven: 'Java/Kotlin',
};

/**
 * Patterns that suggest a package provides framework-level semantics
 * (routing, models, middleware, etc.) that benefit from a dedicated plugin.
 */
const FRAMEWORK_SIGNAL_PATTERNS: RegExp[] = [
  /^@?\w+\/(framework|core|server|client|app)$/i,
  /-(framework|engine|server|middleware|router|orm|queue|worker|sdk)$/i,
  /^(django|flask|fastapi|rails|spring|express|nestjs|nuxt|next)-/i,
];

function assessNeedsPlugin(name: string, ecosystem: Ecosystem): { needs: UnknownPackage['needs_plugin']; reason: string } {
  // Scoped org packages with known framework prefixes
  const frameworkPrefixes: Record<Ecosystem, string[]> = {
    npm: ['@nestjs/', '@angular/', '@vue/', '@nuxt/', '@trpc/', '@apollo/', '@prisma/', '@tanstack/', '@hono/'],
    composer: ['laravel/', 'symfony/', 'livewire/', 'spatie/', 'filament/'],
    pip: ['django-', 'flask-', 'fastapi-', 'celery-', 'starlette-'],
    go: ['github.com/gin-', 'github.com/labstack/', 'github.com/gofiber/', 'gorm.io/'],
    gem: ['rails-', 'devise-', 'pundit-', 'sidekiq-'],
    maven: ['org.springframework'],
  };

  const prefixes = frameworkPrefixes[ecosystem] ?? [];
  for (const prefix of prefixes) {
    if (name.startsWith(prefix)) {
      return { needs: 'likely', reason: `extends known framework (${prefix.replace(/[-/]$/, '')})` };
    }
  }

  for (const pattern of FRAMEWORK_SIGNAL_PATTERNS) {
    if (pattern.test(name)) {
      return { needs: 'maybe', reason: 'name suggests framework-level semantics' };
    }
  }

  // Type-definition packages, polyfills, linters etc — no plugin needed
  const noPluginPatterns = [
    /^@types\//,
    /^eslint/,
    /^prettier/,
    /^stylelint/,
    /-(types|typings|polyfill|shim|loader|preset|config)$/,
    /^babel-/,
    /^postcss-/,
    /^autoprefixer$/,
  ];
  for (const pattern of noPluginPatterns) {
    if (pattern.test(name)) {
      return { needs: 'no', reason: 'tooling/types — language fallback sufficient' };
    }
  }

  return { needs: 'maybe', reason: 'not in catalog — review needed' };
}

// --- Main ---

/** Detect technologies and assess coverage */
export function detectCoverage(projectRoot: string, opts: { includeDev?: boolean } = {}): CoverageReport {
  const { includeDev = false } = opts;
  const manifestsFound: string[] = [];
  const allDeps: DependencyInfo[] = [];

  for (const { file, ecosystem, parser } of MANIFEST_PARSERS) {
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
        ecosystem,
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
    .map(d => {
      const assessment = assessNeedsPlugin(d.name, d.ecosystem);
      return {
        name: d.name,
        version: d.version,
        ecosystem: d.ecosystem,
        language_fallback: true, // all ecosystems have language-level indexing
        needs_plugin: assessment.needs,
        reason: assessment.reason,
      } satisfies UnknownPackage;
    })
    .sort((a, b) => {
      const prio = { likely: 0, maybe: 1, no: 2 };
      return (prio[a.needs_plugin] ?? 3) - (prio[b.needs_plugin] ?? 3);
    });

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

export interface MultiProjectCoverageReport {
  root: string;
  projects: CoverageReport[];
  aggregate: {
    total_projects: number;
    total_significant: number;
    covered: number;
    coverage_pct: number;
  };
}

/**
 * Detect technology coverage across the root project and all recursively
 * discovered child projects (monorepo / subproject support).
 */
export function detectCoverageRecursive(
  projectRoot: string,
  opts: { includeDev?: boolean } = {},
): MultiProjectCoverageReport {
  const rootReport = detectCoverage(projectRoot, opts);
  const childRoots = discoverChildProjectsRecursive(projectRoot);
  const childReports = childRoots.map(child => detectCoverage(child, opts));

  // Include root only if it has manifests (skip bare monorepo containers)
  const allReports = rootReport.manifests_analyzed.length > 0
    ? [rootReport, ...childReports]
    : childReports;

  // Deduplicate dependencies by name across all projects
  const significantSet = new Map<string, DependencyInfo>();
  for (const report of allReports) {
    for (const dep of report.dependencies) {
      if (dep.priority === 'none') continue;
      // Keep the first occurrence (or upgrade if newly covered)
      const existing = significantSet.get(dep.name);
      if (!existing || (existing.coveredByPlugin === null && dep.coveredByPlugin !== null)) {
        significantSet.set(dep.name, dep);
      }
    }
  }

  const totalSignificant = significantSet.size;
  const coveredCount = [...significantSet.values()].filter(d => d.coveredByPlugin !== null).length;

  return {
    root: projectRoot,
    projects: allReports,
    aggregate: {
      total_projects: allReports.length,
      total_significant: totalSignificant,
      covered: coveredCount,
      coverage_pct: totalSignificant > 0 ? Math.round(coveredCount / totalSignificant * 100) : 100,
    },
  };
}
