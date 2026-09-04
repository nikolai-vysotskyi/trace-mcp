import { readEmbeddingBreakerState } from '../../ai/embedding-pipeline.js';
import type { TraceMcpConfig } from '../../config.js';
import type { IndexStats, Store } from '../../db/store.js';
import { getDroppedEventStats } from '../../indexer/watcher.js';
import type { PluginRegistry } from '../../plugin-api/registry.js';
import type { DetectedVersion, ProjectContext } from '../../plugin-api/types.js';
import type { ProgressSnapshot } from '../../progress.js';

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
  progress?: ProgressSnapshot;
  /**
   * Embedding backlog state. Present only when embeddings are configured or a
   * previous run failed — otherwise the extra COUNT isn't worth paying for.
   * Without this, semantic search silently degrades with nothing to look at
   * (TRA-812).
   */
  embedding?: {
    /** Indexed symbols with no vector yet. */
    queued: number;
    /** Epoch ms until which background embedding is paused, if it is. */
    pausedUntil?: number;
    /** Epoch ms of the last failed batch. */
    lastFailureAt?: number;
    /** Message from the last failed batch. */
    lastError?: string;
  };
}

export function getIndexHealth(store: Store, config: TraceMcpConfig): IndexHealthResult {
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

  // Detect linker failures: symbols exist but no edges were linked
  if (stats.totalSymbols > 0 && stats.totalEdges === 0) {
    if (status === 'ok') status = 'degraded';
    warnings.push(
      `${stats.totalSymbols} symbols indexed but 0 edges linked. ` +
        `Call graph queries (get_call_graph, find_usages, get_change_impact) will return empty results. ` +
        `This usually indicates edge resolution failed — check language plugin support and re-run reindex.`,
    );
  } else if (
    stats.totalSymbols > 50 &&
    stats.totalEdges > 0 &&
    stats.totalEdges < stats.totalSymbols * 0.1
  ) {
    // Very low edge-to-symbol ratio suggests partial linker failure
    warnings.push(
      `Low edge density: ${stats.totalEdges} edges for ${stats.totalSymbols} symbols ` +
        `(${Math.round((stats.totalEdges / stats.totalSymbols) * 100)}% ratio). ` +
        `Some call graph queries may return incomplete results.`,
    );
  }

  // The OS dropped fs events at least once this process: everything changed
  // inside those windows was invisible to the watcher until the reconcile pass
  // caught up (TRA-852). Report it — an agent asking about index freshness
  // cannot read the daemon log, which is where this otherwise only exists.
  const { drops, reconciles } = getDroppedEventStats();
  if (drops > 0) {
    warnings.push(
      `The OS dropped file-system events ${drops} time(s) since this process started; ` +
        `${reconciles} index reconcile pass(es) ran in response. ` +
        `Results served between a drop and its reconcile may have been stale.`,
    );
  }

  const versionRow = store.db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;

  const breaker = readEmbeddingBreakerState(store.db);
  let embedding: IndexHealthResult['embedding'];
  if (config.ai?.enabled || breaker) {
    const queued = store.countUnembeddedSymbols();
    const paused = breaker && breaker.disabledUntilMs > Date.now();
    embedding = {
      queued,
      pausedUntil: paused ? breaker.disabledUntilMs : undefined,
      lastFailureAt: breaker?.lastFailureAt || undefined,
      lastError: breaker?.lastError,
    };
    if (paused && queued > 0) {
      if (status === 'ok') status = 'degraded';
      warnings.push(
        `${queued} symbols are queued for embedding but background embedding is paused until ` +
          `${new Date(breaker.disabledUntilMs).toISOString()} after repeated failures ` +
          `(${breaker.lastError ?? 'unknown error'}). Semantic and hybrid search results are ` +
          `incomplete until the embedding provider is reachable; call embed_repo to retry now.`,
      );
    }
  }

  return {
    status,
    stats,
    embedding,
    schemaVersion: versionRow ? Number(versionRow.value) : 0,
    config: {
      // The path this store was actually opened at, not a config default —
      // an agent that stats or deletes this path must hit the real DB (TRA-802).
      dbPath: store.db.name,
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
  diagnostics?: string[];
}

interface ProjectMapSummary {
  frameworks: string[];
  fileCount: number;
  symbolCount: number;
  languages: string[];
  detectedVersions?: DetectedVersion[];
  diagnostics?: string[];
}

function getArtifactDiagnostics(store: Store, frameworks: string[]): string[] | undefined {
  if (frameworks.length > 0) return undefined;

  const counts: string[] = [];
  try {
    const r =
      (store.db.prepare('SELECT COUNT(*) as c FROM routes').get() as { c: number } | undefined)
        ?.c ?? 0;
    if (r > 0) counts.push(`${r} routes`);
  } catch {}
  try {
    const c =
      (store.db.prepare('SELECT COUNT(*) as c FROM components').get() as { c: number } | undefined)
        ?.c ?? 0;
    if (c > 0) counts.push(`${c} components`);
  } catch {}
  try {
    const m =
      (store.db.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number } | undefined)
        ?.c ?? 0;
    if (m > 0) counts.push(`${m} migrations`);
  } catch {}
  try {
    const o =
      (store.db.prepare('SELECT COUNT(*) as c FROM orm_models').get() as { c: number } | undefined)
        ?.c ?? 0;
    if (o > 0) counts.push(`${o} orm_models`);
  } catch {}

  if (counts.length === 0) return undefined;

  return [
    `Indexed artifacts found (${counts.join(', ')}), but no frameworks were detected. Manifest files (package.json, composer.json, etc.) may be missing or located in unindexed directories.`,
  ];
}

export function getProjectMap(
  store: Store,
  registry: PluginRegistry,
  summaryOnly?: boolean,
  projectContext?: ProjectContext,
): ProjectMapResult | ProjectMapSummary {
  const stats = store.getStats();
  let frameworks: string[];
  if (projectContext) {
    const active = registry.getActiveFrameworkPlugins(projectContext);
    frameworks = active.isOk() ? active.value.map((p) => p.manifest.name) : [];
  } else {
    frameworks = registry.getAllFrameworkPlugins().map((p) => p.manifest.name);
  }

  const detectedVersions = projectContext?.detectedVersions;
  const diagnostics = getArtifactDiagnostics(store, frameworks);

  if (summaryOnly) {
    const languageRows = store.db
      .prepare(
        'SELECT language FROM files WHERE language IS NOT NULL GROUP BY language ORDER BY COUNT(*) DESC',
      )
      .all() as { language: string }[];
    return {
      frameworks,
      fileCount: stats.totalFiles,
      symbolCount: stats.totalSymbols,
      languages: languageRows.map((r) => r.language),
      detectedVersions: detectedVersions?.length ? detectedVersions : undefined,
      diagnostics,
    };
  }

  const languageRows = store.db
    .prepare(
      'SELECT language, COUNT(*) as count FROM files WHERE language IS NOT NULL GROUP BY language ORDER BY count DESC',
    )
    .all() as { language: string; count: number }[];

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
    diagnostics,
  };
}
