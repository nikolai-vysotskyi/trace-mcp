/**
 * Context Artifacts — surfaces non-code knowledge from the index.
 *
 * Aggregates already-indexed data into searchable artifact categories:
 *   - database: schemas from migrations / ORM models
 *   - api: endpoints from OpenAPI specs / routes
 *   - infra: services, volumes, networks from docker-compose / K8s / Helm
 *   - ci: jobs, pipelines from GitHub Actions / GitLab CI / CircleCI
 *   - config: env vars, top-level config keys
 *
 * Zero extra I/O — all data comes from the existing DB index.
 */

import type { Store } from '../../db/store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ArtifactCategory = 'database' | 'api' | 'infra' | 'ci' | 'config' | 'all';

interface Artifact {
  category: string;
  kind: string;
  name: string;
  file: string;
  line?: number;
  details?: Record<string, unknown>;
}

interface ArtifactsResult {
  artifacts: Artifact[];
  summary: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Queries — batch by category, no N+1
// ---------------------------------------------------------------------------

function getDbArtifacts(store: Store): Artifact[] {
  const artifacts: Artifact[] = [];

  // ORM models
  const models = store.db.prepare(`
    SELECT m.name, m.orm, m.collection_or_table, f.path, s.line_start
    FROM orm_models m
    LEFT JOIN files f ON m.file_id = f.id
    LEFT JOIN symbols s ON s.file_id = f.id AND s.name = m.name AND s.kind = 'class'
  `).all() as { name: string; orm: string; collection_or_table: string | null; path: string; line_start: number | null }[];

  for (const m of models) {
    artifacts.push({
      category: 'database',
      kind: 'orm_model',
      name: m.name,
      file: m.path ?? '',
      line: m.line_start ?? undefined,
      details: { orm: m.orm, table: m.collection_or_table },
    });
  }

  // Migrations
  const migrations = store.db.prepare(`
    SELECT m.table_name, m.operation, f.path
    FROM migrations m
    LEFT JOIN files f ON m.file_id = f.id
  `).all() as { table_name: string | null; operation: string | null; path: string | null }[];

  for (const m of migrations) {
    artifacts.push({
      category: 'database',
      kind: 'migration',
      name: m.table_name ?? 'unknown',
      file: m.path ?? '',
      details: { table: m.table_name, operation: m.operation },
    });
  }

  return artifacts;
}

function getApiArtifacts(store: Store): Artifact[] {
  const artifacts: Artifact[] = [];

  // Routes
  const routes = store.db.prepare(`
    SELECT r.uri, r.method, r.handler, r.middleware, f.path
    FROM routes r
    LEFT JOIN files f ON r.file_id = f.id
    WHERE r.method NOT IN ('STORE', 'SLICE', 'DISPATCH', 'TASK', 'SIGNAL', 'EVENT', 'LISTENER', 'SUBSCRIBE')
  `).all() as { uri: string; method: string; handler: string | null; middleware: string | null; path: string }[];

  for (const r of routes) {
    artifacts.push({
      category: 'api',
      kind: 'route',
      name: `${r.method} ${r.uri}`,
      file: r.path,
      details: {
        method: r.method,
        uri: r.uri,
        handler: r.handler,
        ...(r.middleware ? { middleware: r.middleware } : {}),
      },
    });
  }

  // OpenAPI endpoints from symbols
  const openApiSymbols = store.db.prepare(`
    SELECT s.name, s.metadata, f.path, s.line_start
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE s.metadata LIKE '%"yamlKind":"endpoint"%'
  `).all() as { name: string; metadata: string | null; path: string; line_start: number | null }[];

  for (const s of openApiSymbols) {
    const meta = s.metadata ? JSON.parse(s.metadata) : {};
    artifacts.push({
      category: 'api',
      kind: 'openapi_endpoint',
      name: s.name,
      file: s.path,
      line: s.line_start ?? undefined,
      details: { method: meta.method, path: meta.path },
    });
  }

  // OpenAPI schemas
  const schemaSymbols = store.db.prepare(`
    SELECT s.name, f.path, s.line_start
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE s.metadata LIKE '%"yamlKind":"schema"%'
  `).all() as { name: string; path: string; line_start: number | null }[];

  for (const s of schemaSymbols) {
    artifacts.push({
      category: 'api',
      kind: 'openapi_schema',
      name: s.name,
      file: s.path,
      line: s.line_start ?? undefined,
    });
  }

  return artifacts;
}

function getInfraArtifacts(store: Store): Artifact[] {
  const artifacts: Artifact[] = [];

  const infraKinds = new Set([
    'service', 'image', 'port', 'volume', 'volumeDef', 'network', 'networkDef',
    'k8sKind', 'k8sName', 'container', 'containerImage', 'volumeMount',
    'configMapRef', 'secretRef', 'serviceSelector', 'chartName',
  ]);

  const symbols = store.db.prepare(`
    SELECT s.name, s.metadata, f.path, s.line_start
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE s.metadata LIKE '%"yamlKind"%'
  `).all() as { name: string; metadata: string | null; path: string; line_start: number | null }[];

  for (const s of symbols) {
    const meta = s.metadata ? JSON.parse(s.metadata) : {};
    if (!infraKinds.has(meta.yamlKind)) continue;

    artifacts.push({
      category: 'infra',
      kind: meta.yamlKind,
      name: s.name,
      file: s.path,
      line: s.line_start ?? undefined,
      details: meta,
    });
  }

  return artifacts;
}

function getCiArtifacts(store: Store): Artifact[] {
  const artifacts: Artifact[] = [];

  const ciKinds = new Set(['job', 'step', 'stage']);

  const symbols = store.db.prepare(`
    SELECT s.name, s.kind, s.metadata, f.path, s.line_start
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE s.metadata LIKE '%"yamlKind"%'
  `).all() as { name: string; kind: string; metadata: string | null; path: string; line_start: number | null }[];

  for (const s of symbols) {
    const meta = s.metadata ? JSON.parse(s.metadata) : {};
    if (!ciKinds.has(meta.yamlKind)) continue;

    artifacts.push({
      category: 'ci',
      kind: meta.yamlKind,
      name: s.name,
      file: s.path,
      line: s.line_start ?? undefined,
      details: meta,
    });
  }

  return artifacts;
}

function getConfigArtifacts(store: Store): Artifact[] {
  const artifacts: Artifact[] = [];

  // Env vars
  try {
    const envVars = store.getAllEnvVars();
    for (const v of envVars) {
      artifacts.push({
        category: 'config',
        kind: 'env_var',
        name: v.key,
        file: v.file_path,
        details: { type: v.value_type, format: v.value_format },
      });
    }
  } catch {
    // env vars table may not exist
  }

  // Docker-compose env vars
  const envSymbols = store.db.prepare(`
    SELECT s.name, s.metadata, f.path, s.line_start
    FROM symbols s JOIN files f ON s.file_id = f.id
    WHERE s.metadata LIKE '%"yamlKind":"envVar"%'
  `).all() as { name: string; metadata: string | null; path: string; line_start: number | null }[];

  for (const s of envSymbols) {
    const meta = s.metadata ? JSON.parse(s.metadata) : {};
    artifacts.push({
      category: 'config',
      kind: 'compose_env',
      name: meta.key ?? s.name,
      file: s.path,
      line: s.line_start ?? undefined,
      details: { service: meta.service },
    });
  }

  return artifacts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Collect context artifacts from the index. Zero I/O — all from DB.
 */
export function getArtifacts(
  store: Store,
  opts: {
    category?: ArtifactCategory;
    query?: string;
    limit?: number;
  },
): ArtifactsResult {
  const category = opts.category ?? 'all';
  const limit = opts.limit ?? 200;

  let artifacts: Artifact[] = [];

  if (category === 'all' || category === 'database') artifacts.push(...getDbArtifacts(store));
  if (category === 'all' || category === 'api') artifacts.push(...getApiArtifacts(store));
  if (category === 'all' || category === 'infra') artifacts.push(...getInfraArtifacts(store));
  if (category === 'all' || category === 'ci') artifacts.push(...getCiArtifacts(store));
  if (category === 'all' || category === 'config') artifacts.push(...getConfigArtifacts(store));

  // Text filter
  if (opts.query) {
    const q = opts.query.toLowerCase();
    artifacts = artifacts.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      a.kind.toLowerCase().includes(q) ||
      (a.file && a.file.toLowerCase().includes(q)),
    );
  }

  // Limit
  artifacts = artifacts.slice(0, limit);

  // Summary
  const summary: Record<string, number> = {};
  for (const a of artifacts) {
    summary[a.category] = (summary[a.category] ?? 0) + 1;
  }

  return { artifacts, summary };
}
