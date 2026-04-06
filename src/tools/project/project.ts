import type { Store, IndexStats } from '../../db/store.js';
import type { PluginRegistry } from '../../plugin-api/registry.js';
import type { TraceMcpConfig } from '../../config.js';
import type { DetectedVersion, ParsedDependency, ProjectContext } from '../../plugin-api/types.js';

interface IndexHealthResult {
  status: 'ok' | 'degraded' | 'empty';
  stats: IndexStats;
  schemaVersion: number;
  config: {
    dbPath: string;
    includePatterns: string[];
    excludePatterns: string[];
  };
  warnings: string[];
}

export function getIndexHealth(
  store: Store,
  config: TraceMcpConfig,
): IndexHealthResult {
  const stats = store.getStats();
  const warnings: string[] = [];

  let status: 'ok' | 'degraded' | 'empty' = 'ok';
  if (stats.totalFiles === 0) {
    status = 'empty';
  } else if (stats.partialFiles > 0 || stats.errorFiles > 0) {
    status = 'degraded';
    if (stats.partialFiles > 0) warnings.push(`${stats.partialFiles} files parsed partially`);
    if (stats.errorFiles > 0) warnings.push(`${stats.errorFiles} files failed to parse`);
  }

  const versionRow = store.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;

  return {
    status,
    stats,
    schemaVersion: versionRow ? Number(versionRow.value) : 0,
    config: {
      dbPath: config.db.path,
      includePatterns: config.include,
      excludePatterns: config.exclude,
    },
    warnings,
  };
}

interface ProjectMapResult {
  frameworks: string[];
  stats: IndexStats;
  languages: { language: string; count: number }[];
  detectedVersions?: DetectedVersion[];
  dependencySummary?: { total: number; dev: number; byEcosystem: Record<string, number> };
}

interface ProjectMapSummary {
  frameworks: string[];
  fileCount: number;
  symbolCount: number;
  languages: string[];
  detectedVersions?: DetectedVersion[];
}

export function getProjectMap(
  store: Store,
  registry: PluginRegistry,
  summaryOnly?: boolean,
  projectContext?: ProjectContext,
): ProjectMapResult | ProjectMapSummary {
  const stats = store.getStats();
  const frameworks = registry.getAllFrameworkPlugins().map((p) => p.manifest.name);

  const detectedVersions = projectContext?.detectedVersions;

  if (summaryOnly) {
    const languageRows = store.db.prepare(
      'SELECT language FROM files WHERE language IS NOT NULL GROUP BY language ORDER BY COUNT(*) DESC',
    ).all() as { language: string }[];
    return {
      frameworks,
      fileCount: stats.totalFiles,
      symbolCount: stats.totalSymbols,
      languages: languageRows.map((r) => r.language),
      detectedVersions: detectedVersions?.length ? detectedVersions : undefined,
    };
  }

  const languageRows = store.db.prepare(
    'SELECT language, COUNT(*) as count FROM files WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC',
  ).all() as { language: string; count: number }[];

  let dependencySummary: ProjectMapResult['dependencySummary'];
  if (projectContext?.allDependencies.length) {
    const deps = projectContext.allDependencies;
    const byEcosystem: Record<string, number> = {};
    for (const d of deps) {
      // Infer ecosystem from naming patterns
      let eco = 'other';
      if (d.name.includes('/') && !d.name.includes(':')) eco = 'npm';
      else if (d.name.includes(':')) eco = 'maven';
      else if (d.name.startsWith('@')) eco = 'npm';
      else if (projectContext.packageJson && !d.name.includes('.')) eco = 'npm';
      else if (projectContext.composerJson && d.name.includes('/')) eco = 'composer';
      else if (projectContext.goMod && d.name.includes('/')) eco = 'go';
      else if (projectContext.cargoToml) eco = 'cargo';
      else if (projectContext.gemfile) eco = 'rubygems';
      else if (projectContext.pyprojectToml || projectContext.requirementsTxt) eco = 'pypi';
      else if (projectContext.pomXml || projectContext.buildGradle) eco = 'maven';
      byEcosystem[eco] = (byEcosystem[eco] ?? 0) + 1;
    }
    dependencySummary = {
      total: deps.length,
      dev: deps.filter((d) => d.dev).length,
      byEcosystem,
    };
  }

  return {
    frameworks,
    stats,
    languages: languageRows,
    detectedVersions: detectedVersions?.length ? detectedVersions : undefined,
    dependencySummary,
  };
}
