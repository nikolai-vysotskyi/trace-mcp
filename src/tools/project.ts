import type { Store, IndexStats } from '../db/store.js';
import type { PluginRegistry } from '../plugin-api/registry.js';
import type { TraceMcpConfig } from '../config.js';

export interface IndexHealthResult {
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

export interface ProjectMapResult {
  frameworks: string[];
  stats: IndexStats;
  languages: { language: string; count: number }[];
}

export interface ProjectMapSummary {
  frameworks: string[];
  fileCount: number;
  symbolCount: number;
  languages: string[];
}

export function getProjectMap(store: Store, registry: PluginRegistry, summaryOnly?: boolean): ProjectMapResult | ProjectMapSummary {
  const stats = store.getStats();
  const frameworks = registry.getAllFrameworkPlugins().map((p) => p.manifest.name);

  if (summaryOnly) {
    const languageRows = store.db.prepare(
      'SELECT language FROM files WHERE language IS NOT NULL GROUP BY language ORDER BY COUNT(*) DESC',
    ).all() as { language: string }[];
    return {
      frameworks,
      fileCount: stats.totalFiles,
      symbolCount: stats.totalSymbols,
      languages: languageRows.map((r) => r.language),
    };
  }

  const languageRows = store.db.prepare(
    'SELECT language, COUNT(*) as count FROM files WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC',
  ).all() as { language: string; count: number }[];

  return {
    frameworks,
    stats,
    languages: languageRows,
  };
}
