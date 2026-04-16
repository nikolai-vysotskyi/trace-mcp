/**
 * Topology Store — manages the cross-service topology database (~/.trace-mcp/topology.db).
 * Separate from per-repo DBs. Stores services, API contracts, endpoints, events, and cross-service edges.
 */

import Database from 'better-sqlite3';
import { logger } from '../logger.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface ServiceRow {
  id: number;
  name: string;
  repo_root: string;
  db_path: string;
  service_type: string | null;
  detection_source: string | null;
  project_group: string | null;
  metadata: string | null;
  indexed_at: string;
}

export interface ContractRow {
  id: number;
  service_id: number;
  contract_type: string;
  spec_path: string;
  version: string | null;
  content_hash: string | null;
  parsed_spec: string;
  indexed_at: string;
}

export interface EndpointRow {
  id: number;
  contract_id: number;
  service_id: number;
  method: string | null;
  path: string;
  operation_id: string | null;
  request_schema: string | null;
  response_schema: string | null;
  metadata: string | null;
}

interface EventChannelRow {
  id: number;
  contract_id: number | null;
  service_id: number;
  channel_name: string;
  direction: string;
  payload_schema: string | null;
  metadata: string | null;
}

export interface CrossServiceEdgeRow {
  id: number;
  source_service_id: number;
  target_service_id: number;
  edge_type: string;
  source_ref: string | null;
  target_ref: string | null;
  confidence: number;
  metadata: string | null;
}

export interface SubprojectRow {
  id: number;
  name: string;
  repo_root: string;
  project_root: string;
  db_path: string | null;
  contract_paths: string | null;
  added_at: string;
  last_synced: string | null;
  metadata: string | null;
}

export interface ClientCallRow {
  id: number;
  source_repo_id: number;
  target_repo_id: number | null;
  file_path: string;
  line: number | null;
  call_type: string;
  method: string | null;
  url_pattern: string;
  matched_endpoint_id: number | null;
  confidence: number;
  metadata: string | null;
}

export interface ContractSnapshotRow {
  id: number;
  contract_id: number;
  service_id: number;
  version: string | null;
  spec_path: string;
  content_hash: string;
  endpoints_json: string;
  events_json: string;
  snapshot_at: string;
}

// ════════════════════════════════════════════════════════════════════════
// SCHEMA DDL
// ════════════════════════════════════════════════════════════════════════

const TOPOLOGY_DDL = `
CREATE TABLE IF NOT EXISTS services (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    repo_root       TEXT NOT NULL,
    db_path         TEXT NOT NULL,
    service_type    TEXT,
    detection_source TEXT,
    project_group   TEXT,
    metadata        TEXT,
    indexed_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_contracts (
    id              INTEGER PRIMARY KEY,
    service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    contract_type   TEXT NOT NULL,
    spec_path       TEXT NOT NULL,
    version         TEXT,
    content_hash    TEXT,
    parsed_spec     TEXT NOT NULL,
    indexed_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contracts_service ON api_contracts(service_id);

CREATE TABLE IF NOT EXISTS api_endpoints (
    id              INTEGER PRIMARY KEY,
    contract_id     INTEGER NOT NULL REFERENCES api_contracts(id) ON DELETE CASCADE,
    service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    method          TEXT,
    path            TEXT NOT NULL,
    operation_id    TEXT,
    request_schema  TEXT,
    response_schema TEXT,
    metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_endpoints_service ON api_endpoints(service_id);
CREATE INDEX IF NOT EXISTS idx_endpoints_path ON api_endpoints(path);

CREATE TABLE IF NOT EXISTS event_channels (
    id              INTEGER PRIMARY KEY,
    contract_id     INTEGER REFERENCES api_contracts(id) ON DELETE CASCADE,
    service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    channel_name    TEXT NOT NULL,
    direction       TEXT NOT NULL,
    payload_schema  TEXT,
    metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_service ON event_channels(service_id);
CREATE INDEX IF NOT EXISTS idx_events_channel ON event_channels(channel_name);

CREATE TABLE IF NOT EXISTS cross_service_edges (
    id              INTEGER PRIMARY KEY,
    source_service_id   INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    target_service_id   INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    edge_type       TEXT NOT NULL,
    source_ref      TEXT,
    target_ref      TEXT,
    confidence      REAL NOT NULL DEFAULT 1.0,
    metadata        TEXT,
    UNIQUE(source_service_id, target_service_id, edge_type, source_ref, target_ref)
);
CREATE INDEX IF NOT EXISTS idx_xedges_source ON cross_service_edges(source_service_id);
CREATE INDEX IF NOT EXISTS idx_xedges_target ON cross_service_edges(target_service_id);

CREATE TABLE IF NOT EXISTS topology_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ════════════════════════════════════════════════════════════════
-- SUBPROJECTS — explicit multi-repo graph linking
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS subprojects (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    repo_root       TEXT NOT NULL,
    project_root    TEXT NOT NULL,
    db_path         TEXT,
    contract_paths  TEXT,
    added_at        TEXT NOT NULL,
    last_synced     TEXT,
    metadata        TEXT,
    UNIQUE(repo_root, project_root)
);
CREATE INDEX IF NOT EXISTS idx_subprojects_project ON subprojects(project_root);

CREATE TABLE IF NOT EXISTS client_calls (
    id              INTEGER PRIMARY KEY,
    source_repo_id  INTEGER NOT NULL REFERENCES subprojects(id) ON DELETE CASCADE,
    target_repo_id  INTEGER REFERENCES subprojects(id),
    file_path       TEXT NOT NULL,
    line            INTEGER,
    call_type       TEXT NOT NULL,
    method          TEXT,
    url_pattern     TEXT NOT NULL,
    matched_endpoint_id INTEGER REFERENCES api_endpoints(id),
    confidence      REAL NOT NULL DEFAULT 0.5,
    metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_calls_source ON client_calls(source_repo_id);
CREATE INDEX IF NOT EXISTS idx_client_calls_target ON client_calls(target_repo_id);
CREATE INDEX IF NOT EXISTS idx_client_calls_endpoint ON client_calls(matched_endpoint_id);

-- ════════════════════════════════════════════════════════════════
-- CONTRACT SNAPSHOTS — historical contract versions for diffing
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS contract_snapshots (
    id              INTEGER PRIMARY KEY,
    contract_id     INTEGER NOT NULL REFERENCES api_contracts(id) ON DELETE CASCADE,
    service_id      INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    version         TEXT,
    spec_path       TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    endpoints_json  TEXT NOT NULL,
    events_json     TEXT NOT NULL,
    snapshot_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_contract ON contract_snapshots(contract_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_service ON contract_snapshots(service_id);
`;

// ════════════════════════════════════════════════════════════════════════
// TOPOLOGY STORE
// ════════════════════════════════════════════════════════════════════════

/**
 * Match a client call URL pattern to the best-fitting endpoint.
 * Normalizes path params ({id}, :id) and compares.
 */
function findBestEndpointMatch(
  urlPattern: string,
  method: string | null,
  endpoints: Array<EndpointRow & { service_name: string }>,
): (EndpointRow & { service_name: string; confidence: number }) | null {
  // Normalize: /api/users/{id} and /api/users/:id → /api/users/{*}
  const normalize = (p: string) =>
    p.replace(/\{[^}]+\}/g, '{*}').replace(/:[\w]+/g, '{*}').replace(/\/+$/, '');

  const normalizedUrl = normalize(urlPattern);
  // Skip overly generic URL patterns — they match everything and produce false positives
  if (!normalizedUrl || normalizedUrl === '/' || normalizedUrl === '') return null;

  let bestMatch: (EndpointRow & { service_name: string; confidence: number }) | null = null;
  let bestScore = 0;

  for (const ep of endpoints) {
    const normalizedEp = normalize(ep.path);
    // Skip root endpoints — too generic to produce meaningful matches
    if (!normalizedEp || normalizedEp === '/' || normalizedEp === '') continue;

    // Exact match
    if (normalizedUrl === normalizedEp) {
      const methodBonus = (method && ep.method && method.toUpperCase() === ep.method.toUpperCase()) ? 0.2 : 0;
      const score = 1.0 + methodBonus;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { ...ep, confidence: Math.min(score, 1.0) };
      }
      continue;
    }

    // Partial: url ends with the endpoint path
    if (normalizedUrl.endsWith(normalizedEp) || normalizedEp.endsWith(normalizedUrl)) {
      const score = 0.7;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { ...ep, confidence: score };
      }
    }
  }

  return bestMatch;
}

export class TopologyStore {
  public readonly db: Database.Database;

  constructor(dbPath: string, opts?: { readonly?: boolean }) {
    this.db = new Database(dbPath, { readonly: opts?.readonly ?? false });
    if (opts?.readonly) {
      this.db.pragma('busy_timeout = 5000');
      logger.debug({ dbPath, readonly: true }, 'Topology database opened (readonly)');
    } else {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.preMigrate();
      this.db.exec(TOPOLOGY_DDL);
      this.migrate();
      logger.debug({ dbPath }, 'Topology database initialized');
    }
  }

  /**
   * Fix legacy schemas BEFORE DDL runs — prevents crashes when
   * CREATE INDEX references columns that don't exist in old tables.
   */
  private preMigrate(): void {
    // Migrate legacy federated_repos → subprojects
    const hasLegacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='federated_repos'")
      .get();
    if (hasLegacy) {
      this.db.exec(`
        DELETE FROM client_calls;
        DROP TABLE IF EXISTS federated_repos;
      `);
      logger.info('Pre-migration: dropped legacy federated_repos table (replaced by subprojects)');
    }

    const hasTable = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subprojects'")
      .get();
    if (hasTable) {
      const cols = (this.db.pragma('table_info(subprojects)') as Array<{ name: string }>).map((c) => c.name);
      if (!cols.includes('project_root')) {
        this.db.exec(`
          DELETE FROM client_calls;
          DROP TABLE IF EXISTS subprojects;
        `);
        logger.info('Pre-migration: dropped legacy subprojects missing project_root column');
      }
    }
  }

  private migrate(): void {
    const cols = (this.db.pragma('table_info(services)') as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('project_group')) {
      this.db.exec('ALTER TABLE services ADD COLUMN project_group TEXT');
    }

    // Migration: subprojects table requires project_root column.
    // Drop all old data and let auto-sync rebuild it correctly.
    const subCols = (this.db.pragma('table_info(subprojects)') as Array<{ name: string }>).map((c) => c.name);
    if (!subCols.includes('project_root')) {
      this.db.exec(`
        DELETE FROM client_calls;
        DELETE FROM subprojects;
        DROP TABLE IF EXISTS subprojects;
        CREATE TABLE IF NOT EXISTS subprojects (
          id              INTEGER PRIMARY KEY,
          name            TEXT NOT NULL,
          repo_root       TEXT NOT NULL,
          project_root    TEXT NOT NULL,
          db_path         TEXT,
          contract_paths  TEXT,
          added_at        TEXT NOT NULL,
          last_synced     TEXT,
          metadata        TEXT,
          UNIQUE(repo_root, project_root)
        );
        CREATE INDEX IF NOT EXISTS idx_subprojects_project ON subprojects(project_root);
      `);
      logger.info('Migration: rebuilt subprojects with project_root column, old data cleared');
    }

    // Migration: clean up duplicate framework_routes contracts and non-HTTP endpoints.
    // Prior to this fix, add()/autoDiscoverSubprojects() appended contracts without
    // clearing old ones, and extractRoutesFromDb() included CLI/JOB/TOOL/TEST routes.
    this.runOnce('clean_duplicate_contracts_v1', () => {
      // For each service, keep only the LATEST framework_routes contract and delete older duplicates.
      const services = this.db.prepare(
        `SELECT DISTINCT service_id FROM api_contracts WHERE contract_type = 'framework_routes'`,
      ).all() as Array<{ service_id: number }>;

      let deletedContracts = 0;
      let deletedEndpoints = 0;

      for (const { service_id } of services) {
        // Find the latest contract (highest id) per service
        const latest = this.db.prepare(
          `SELECT id FROM api_contracts WHERE service_id = ? AND contract_type = 'framework_routes' ORDER BY id DESC LIMIT 1`,
        ).get(service_id) as { id: number } | undefined;

        if (!latest) continue;

        // Delete all older framework_routes contracts (cascade deletes their endpoints)
        const result = this.db.prepare(
          `DELETE FROM api_contracts WHERE service_id = ? AND contract_type = 'framework_routes' AND id != ?`,
        ).run(service_id, latest.id);
        deletedContracts += result.changes;

        // Delete non-HTTP endpoints from the remaining contract
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'];
        const placeholders = httpMethods.map(() => '?').join(',');
        const epResult = this.db.prepare(
          `DELETE FROM api_endpoints WHERE contract_id = ? AND method IS NOT NULL AND method NOT IN (${placeholders})`,
        ).run(latest.id, ...httpMethods);
        deletedEndpoints += epResult.changes;
      }

      if (deletedContracts > 0 || deletedEndpoints > 0) {
        logger.info({ deletedContracts, deletedEndpoints }, 'Migration: cleaned duplicate contracts and non-HTTP endpoints');
      }
    });

    // Migration: clear stale cross_service_edges that pointed to non-HTTP endpoints.
    // These were created when services had 230K+ fake endpoints (TEST/TOOL/CLI/JOB routes).
    // All edges need to be rebuilt from scratch after topology data is cleaned.
    this.runOnce('rebuild_cross_service_edges_v1', () => {
      const result = this.db.prepare('DELETE FROM cross_service_edges').run();
      if (result.changes > 0) {
        logger.info({ deleted: result.changes }, 'Migration: cleared stale cross-service edges for rebuild');
      }
    });

    // Migration: rebuild client_calls table to fix FK references.
    // Legacy table referenced federated_repos(id) which no longer exists.
    // Must recreate with subprojects(id) references.
    this.runOnce('fix_client_calls_fk_v1', () => {
      const hasLegacyFk = (this.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='client_calls'",
      ).get() as { sql: string } | undefined)?.sql?.includes('federated_repos');

      if (hasLegacyFk) {
        this.db.exec(`
          DROP TABLE IF EXISTS client_calls;
          CREATE TABLE client_calls (
            id              INTEGER PRIMARY KEY,
            source_repo_id  INTEGER NOT NULL REFERENCES subprojects(id) ON DELETE CASCADE,
            target_repo_id  INTEGER REFERENCES subprojects(id),
            file_path       TEXT NOT NULL,
            line            INTEGER,
            call_type       TEXT NOT NULL,
            method          TEXT,
            url_pattern     TEXT NOT NULL,
            matched_endpoint_id INTEGER REFERENCES api_endpoints(id),
            confidence      REAL NOT NULL DEFAULT 0.5,
            metadata        TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_client_calls_source ON client_calls(source_repo_id);
          CREATE INDEX IF NOT EXISTS idx_client_calls_target ON client_calls(target_repo_id);
          CREATE INDEX IF NOT EXISTS idx_client_calls_endpoint ON client_calls(matched_endpoint_id);
        `);
        logger.info('Migration: rebuilt client_calls with correct FK references (subprojects instead of federated_repos)');
      }
    });
  }

  /** Run a migration block exactly once, tracked by key in topology_meta. */
  private runOnce(key: string, fn: () => void): void {
    const existing = this.db.prepare('SELECT value FROM topology_meta WHERE key = ?').get(key);
    if (existing) return;
    fn();
    this.db.prepare('INSERT OR REPLACE INTO topology_meta (key, value) VALUES (?, ?)').run(key, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  // ── Services ─────────────────────────────────────────────────────────

  upsertService(input: {
    name: string;
    repoRoot: string;
    dbPath: string;
    serviceType?: string;
    detectionSource?: string;
    projectGroup?: string;
    metadata?: Record<string, unknown>;
  }): number {
    const existing = this.db.prepare('SELECT id FROM services WHERE name = ?').get(input.name) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE services SET repo_root = ?, db_path = ?, service_type = COALESCE(?, service_type),
          detection_source = COALESCE(?, detection_source),
          project_group = COALESCE(?, project_group),
          metadata = COALESCE(?, metadata),
          indexed_at = datetime('now')
        WHERE id = ?
      `).run(input.repoRoot, input.dbPath, input.serviceType ?? null, input.detectionSource ?? null,
        input.projectGroup ?? null, input.metadata ? JSON.stringify(input.metadata) : null, existing.id);
      return existing.id;
    }

    return this.db.prepare(`
      INSERT INTO services (name, repo_root, db_path, service_type, detection_source, project_group, metadata, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(input.name, input.repoRoot, input.dbPath, input.serviceType ?? null,
      input.detectionSource ?? null, input.projectGroup ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ).lastInsertRowid as number;
  }

  getService(name: string): ServiceRow | undefined {
    return this.db.prepare('SELECT * FROM services WHERE name = ?').get(name) as ServiceRow | undefined;
  }

  getAllServices(): ServiceRow[] {
    return this.db.prepare('SELECT * FROM services ORDER BY name').all() as ServiceRow[];
  }

  updateServiceGroup(serviceId: number, projectGroup: string | null): void {
    this.db.prepare('UPDATE services SET project_group = ? WHERE id = ?').run(projectGroup, serviceId);
  }

  getServicesWithEndpointCounts(projectRoot?: string): Array<ServiceRow & { endpoint_count: number }> {
    if (projectRoot) {
      return this.db.prepare(`
        SELECT s.*, (SELECT COUNT(*) FROM api_endpoints WHERE service_id = s.id) as endpoint_count
        FROM services s
        WHERE s.repo_root IN (SELECT repo_root FROM subprojects WHERE project_root = ?)
        ORDER BY s.project_group NULLS LAST, s.name
      `).all(projectRoot) as Array<ServiceRow & { endpoint_count: number }>;
    }
    return this.db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM api_endpoints WHERE service_id = s.id) as endpoint_count
      FROM services s ORDER BY s.project_group NULLS LAST, s.name
    `).all() as Array<ServiceRow & { endpoint_count: number }>;
  }

  deleteService(id: number): void {
    this.db.prepare('DELETE FROM services WHERE id = ?').run(id);
  }

  // ── Contracts ────────────────────────────────────────────────────────

  insertContract(serviceId: number, input: {
    contractType: string;
    specPath: string;
    version?: string;
    contentHash?: string;
    parsedSpec: string;
  }): number {
    return this.db.prepare(`
      INSERT INTO api_contracts (service_id, contract_type, spec_path, version, content_hash, parsed_spec, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(serviceId, input.contractType, input.specPath, input.version ?? null,
      input.contentHash ?? null, input.parsedSpec,
    ).lastInsertRowid as number;
  }

  getContractsByService(serviceId: number): ContractRow[] {
    return this.db.prepare('SELECT * FROM api_contracts WHERE service_id = ?').all(serviceId) as ContractRow[];
  }

  deleteContractsByService(serviceId: number): void {
    this.db.prepare('DELETE FROM api_contracts WHERE service_id = ?').run(serviceId);
  }

  // ── Endpoints ────────────────────────────────────────────────────────

  insertEndpoints(contractId: number, serviceId: number, endpoints: Array<{
    method?: string;
    path: string;
    operationId?: string;
    requestSchema?: string;
    responseSchema?: string;
    metadata?: Record<string, unknown>;
  }>): void {
    const stmt = this.db.prepare(`
      INSERT INTO api_endpoints (contract_id, service_id, method, path, operation_id, request_schema, response_schema, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const ep of endpoints) {
        stmt.run(contractId, serviceId, ep.method ?? null, ep.path,
          ep.operationId ?? null, ep.requestSchema ?? null, ep.responseSchema ?? null,
          ep.metadata ? JSON.stringify(ep.metadata) : null);
      }
    })();
  }

  getEndpointsByService(serviceId: number): EndpointRow[] {
    return this.db.prepare('SELECT * FROM api_endpoints WHERE service_id = ?').all(serviceId) as EndpointRow[];
  }

  findEndpointByPath(pathQuery: string, method?: string): Array<EndpointRow & { service_name: string }> {
    // Escape LIKE wildcards in user input
    const escaped = pathQuery.replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    if (method) {
      return this.db.prepare(`
        SELECT e.*, s.name as service_name FROM api_endpoints e
        JOIN services s ON e.service_id = s.id
        WHERE e.path LIKE ? ESCAPE '\\' AND e.method = ?
      `).all(pattern, method) as Array<EndpointRow & { service_name: string }>;
    }
    return this.db.prepare(`
      SELECT e.*, s.name as service_name FROM api_endpoints e
      JOIN services s ON e.service_id = s.id
      WHERE e.path LIKE ? ESCAPE '\\'
    `).all(pattern) as Array<EndpointRow & { service_name: string }>;
  }

  getAllEndpoints(): Array<EndpointRow & { service_name: string }> {
    return this.db.prepare(`
      SELECT e.*, s.name as service_name FROM api_endpoints e
      JOIN services s ON e.service_id = s.id
      ORDER BY s.name, e.path
    `).all() as Array<EndpointRow & { service_name: string }>;
  }

  // ── Event Channels ──────────────────────────────────────────────────

  insertEventChannels(contractId: number | null, serviceId: number, channels: Array<{
    channelName: string;
    direction: 'publish' | 'subscribe';
    payloadSchema?: string;
  }>): void {
    const stmt = this.db.prepare(`
      INSERT INTO event_channels (contract_id, service_id, channel_name, direction, payload_schema)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const ch of channels) {
        stmt.run(contractId, serviceId, ch.channelName, ch.direction, ch.payloadSchema ?? null);
      }
    })();
  }

  getEventsByService(serviceId: number): EventChannelRow[] {
    return this.db.prepare('SELECT * FROM event_channels WHERE service_id = ?').all(serviceId) as EventChannelRow[];
  }

  matchProducersConsumers(): Array<{ channel: string; publishers: string[]; subscribers: string[] }> {
    const rows = this.db.prepare(`
      SELECT ec.channel_name, ec.direction, s.name as service_name
      FROM event_channels ec
      JOIN services s ON ec.service_id = s.id
      ORDER BY ec.channel_name
    `).all() as Array<{ channel_name: string; direction: string; service_name: string }>;

    const map = new Map<string, { publishers: string[]; subscribers: string[] }>();
    for (const row of rows) {
      if (!map.has(row.channel_name)) map.set(row.channel_name, { publishers: [], subscribers: [] });
      const entry = map.get(row.channel_name)!;
      if (row.direction === 'publish') entry.publishers.push(row.service_name);
      else entry.subscribers.push(row.service_name);
    }

    return [...map.entries()]
      .filter(([, v]) => v.publishers.length > 0 && v.subscribers.length > 0)
      .map(([channel, v]) => ({ channel, ...v }));
  }

  // ── Cross-Service Edges ─────────────────────────────────────────────

  insertCrossServiceEdge(input: {
    sourceServiceId: number;
    targetServiceId: number;
    edgeType: string;
    sourceRef?: string;
    targetRef?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): number {
    return this.db.prepare(`
      INSERT OR IGNORE INTO cross_service_edges
        (source_service_id, target_service_id, edge_type, source_ref, target_ref, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sourceServiceId, input.targetServiceId, input.edgeType,
      input.sourceRef ?? null, input.targetRef ?? null,
      input.confidence ?? 1.0, input.metadata ? JSON.stringify(input.metadata) : null,
    ).lastInsertRowid as number;
  }

  getAllCrossServiceEdges(): Array<CrossServiceEdgeRow & { source_name: string; target_name: string }> {
    return this.db.prepare(`
      SELECT e.*, s1.name as source_name, s2.name as target_name
      FROM cross_service_edges e
      JOIN services s1 ON e.source_service_id = s1.id
      JOIN services s2 ON e.target_service_id = s2.id
      ORDER BY e.confidence DESC
    `).all() as Array<CrossServiceEdgeRow & { source_name: string; target_name: string }>;
  }

  getEdgesBySource(serviceId: number): Array<CrossServiceEdgeRow & { target_name: string }> {
    return this.db.prepare(`
      SELECT e.*, s.name as target_name FROM cross_service_edges e
      JOIN services s ON e.target_service_id = s.id
      WHERE e.source_service_id = ?
    `).all(serviceId) as Array<CrossServiceEdgeRow & { target_name: string }>;
  }

  getEdgesByTarget(serviceId: number): Array<CrossServiceEdgeRow & { source_name: string }> {
    return this.db.prepare(`
      SELECT e.*, s.name as source_name FROM cross_service_edges e
      JOIN services s ON e.source_service_id = s.id
      WHERE e.target_service_id = ?
    `).all(serviceId) as Array<CrossServiceEdgeRow & { source_name: string }>;
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getTopologyStats(): { services: number; contracts: number; endpoints: number; events: number; crossEdges: number } {
    const cnt = (sql: string) => (this.db.prepare(sql).get() as { cnt: number }).cnt;
    return {
      services: cnt('SELECT COUNT(*) as cnt FROM services'),
      contracts: cnt('SELECT COUNT(*) as cnt FROM api_contracts'),
      endpoints: cnt('SELECT COUNT(*) as cnt FROM api_endpoints'),
      events: cnt('SELECT COUNT(*) as cnt FROM event_channels'),
      crossEdges: cnt('SELECT COUNT(*) as cnt FROM cross_service_edges'),
    };
  }

  // ── Subprojects ───────────────────────────────────────────────

  upsertSubproject(input: {
    name: string;
    repoRoot: string;
    projectRoot: string;
    dbPath?: string;
    contractPaths?: string[];
    metadata?: Record<string, unknown>;
  }): number {
    const existing = this.db.prepare(
      'SELECT id FROM subprojects WHERE repo_root = ? AND project_root = ?',
    ).get(input.repoRoot, input.projectRoot) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE subprojects SET name = ?, db_path = COALESCE(?, db_path),
          contract_paths = COALESCE(?, contract_paths),
          metadata = COALESCE(?, metadata), last_synced = datetime('now')
        WHERE id = ?
      `).run(input.name, input.dbPath ?? null,
        input.contractPaths ? JSON.stringify(input.contractPaths) : null,
        input.metadata ? JSON.stringify(input.metadata) : null, existing.id);
      return existing.id;
    }

    return this.db.prepare(`
      INSERT INTO subprojects (name, repo_root, project_root, db_path, contract_paths, metadata, added_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(input.name, input.repoRoot, input.projectRoot, input.dbPath ?? null,
      input.contractPaths ? JSON.stringify(input.contractPaths) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ).lastInsertRowid as number;
  }

  getSubproject(nameOrRoot: string, projectRoot?: string): SubprojectRow | undefined {
    if (projectRoot) {
      return (this.db.prepare('SELECT * FROM subprojects WHERE (name = ? OR repo_root = ?) AND project_root = ?')
        .get(nameOrRoot, nameOrRoot, projectRoot) as SubprojectRow | undefined);
    }
    return (this.db.prepare('SELECT * FROM subprojects WHERE name = ? OR repo_root = ?')
      .get(nameOrRoot, nameOrRoot) as SubprojectRow | undefined);
  }

  getSubprojectsByProject(projectRoot: string): SubprojectRow[] {
    return this.db.prepare('SELECT * FROM subprojects WHERE project_root = ? ORDER BY name').all(projectRoot) as SubprojectRow[];
  }

  getAllSubprojects(): SubprojectRow[] {
    return this.db.prepare('SELECT * FROM subprojects ORDER BY name').all() as SubprojectRow[];
  }

  deleteSubproject(id: number): void {
    this.db.prepare('DELETE FROM subprojects WHERE id = ?').run(id);
  }

  /**
   * Remove all topology data associated with a repo root:
   * subprojects (+ cascading client_calls), services (+ cascading contracts,
   * endpoints, events, edges, snapshots).
   * Returns counts of deleted rows for logging.
   */
  removeByRepoRoot(repoRoot: string): { subprojects: number; services: number } {
    const result = { subprojects: 0, services: 0 };

    // Delete subproject entry (cascades to client_calls)
    const sub = this.getSubproject(repoRoot);
    if (sub) {
      this.deleteSubproject(sub.id);
      result.subprojects = 1;
    }

    // Delete all services rooted in this path (cascades to contracts, endpoints, events, edges, snapshots)
    const services = this.db.prepare('SELECT id FROM services WHERE repo_root = ?').all(repoRoot) as Array<{ id: number }>;
    if (services.length > 0) {
      this.db.transaction(() => {
        for (const svc of services) {
          this.deleteService(svc.id);
        }
      })();
      result.services = services.length;
    }

    return result;
  }

  updateSubprojectSyncTime(id: number): void {
    this.db.prepare("UPDATE subprojects SET last_synced = datetime('now') WHERE id = ?").run(id);
  }

  // ── Client Calls ──────────────────────────────────────────────────

  insertClientCalls(calls: Array<{
    sourceRepoId: number;
    targetRepoId?: number;
    filePath: string;
    line?: number;
    callType: string;
    method?: string;
    urlPattern: string;
    matchedEndpointId?: number;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }>): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO client_calls
        (source_repo_id, target_repo_id, file_path, line, call_type, method, url_pattern,
         matched_endpoint_id, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const c of calls) {
        stmt.run(c.sourceRepoId, c.targetRepoId ?? null, c.filePath, c.line ?? null,
          c.callType, c.method ?? null, c.urlPattern,
          c.matchedEndpointId ?? null, c.confidence ?? 0.5,
          c.metadata ? JSON.stringify(c.metadata) : null);
      }
    })();
  }

  deleteClientCallsByRepo(repoId: number): void {
    this.db.prepare('DELETE FROM client_calls WHERE source_repo_id = ?').run(repoId);
  }

  getClientCallsByEndpoint(endpointId: number): Array<ClientCallRow & { source_repo_name: string }> {
    return this.db.prepare(`
      SELECT cc.*, fr.name as source_repo_name FROM client_calls cc
      JOIN subprojects sp ON cc.source_repo_id = sp.id
      WHERE cc.matched_endpoint_id = ?
      ORDER BY cc.confidence DESC
    `).all(endpointId) as Array<ClientCallRow & { source_repo_name: string }>;
  }

  getClientCallsByRepo(repoId: number): ClientCallRow[] {
    return this.db.prepare('SELECT * FROM client_calls WHERE source_repo_id = ? ORDER BY file_path, line')
      .all(repoId) as ClientCallRow[];
  }

  getClientCallsForTarget(targetRepoId: number): Array<ClientCallRow & { source_repo_name: string }> {
    return this.db.prepare(`
      SELECT cc.*, sp.name as source_repo_name FROM client_calls cc
      JOIN subprojects sp ON cc.source_repo_id = sp.id
      WHERE cc.target_repo_id = ?
      ORDER BY cc.confidence DESC
    `).all(targetRepoId) as Array<ClientCallRow & { source_repo_name: string }>;
  }

  /** Match unlinked client calls to known endpoints. Returns number of newly linked calls. */
  linkClientCallsToEndpoints(): number {
    // Match by URL pattern similarity, respecting project_group isolation.
    // fair-front should only match fair-laravel endpoints, not thewed-laravel's.
    const unlinked = this.db.prepare(
      'SELECT * FROM client_calls WHERE matched_endpoint_id IS NULL',
    ).all() as ClientCallRow[];

    const endpoints = this.getAllEndpoints();
    const services = this.getAllServices();

    // Build service_id → project_group lookup
    const serviceGroup = new Map<number, string | null>();
    for (const svc of services) {
      serviceGroup.set(svc.id, svc.project_group ?? null);
    }

    // Build source_repo_id → project_group lookup (via repo_root → service match)
    const repoGroup = new Map<number, string | null>();
    const allRepos = this.getAllSubprojects();
    for (const repo of allRepos) {
      const svc = services.find((s) => s.repo_root === repo.repo_root);
      repoGroup.set(repo.id, svc?.project_group ?? null);
    }

    let linked = 0;

    const updateStmt = this.db.prepare(
      'UPDATE client_calls SET matched_endpoint_id = ?, target_repo_id = ?, confidence = ? WHERE id = ?',
    );

    this.db.transaction(() => {
      for (const call of unlinked) {
        const sourceGroup = repoGroup.get(call.source_repo_id);

        // Filter endpoints to same project_group when group is known
        // Strict group isolation: only match endpoints from the same group.
        // Ungrouped sources only match ungrouped endpoints.
        const candidateEndpoints = endpoints.filter((ep) => {
          const epGroup = serviceGroup.get(ep.service_id) ?? null;
          return epGroup === sourceGroup;
        });

        const match = findBestEndpointMatch(call.url_pattern, call.method, candidateEndpoints);
        if (match) {
          // Find the repo for this service
          const svc = this.db.prepare('SELECT repo_root FROM services WHERE id = ?')
            .get(match.service_id) as { repo_root: string } | undefined;
          const targetRepo = svc
            ? this.db.prepare('SELECT id FROM subprojects WHERE repo_root = ?')
                .get(svc.repo_root) as { id: number } | undefined
            : undefined;

          updateStmt.run(match.id, targetRepo?.id ?? null, match.confidence, call.id);
          linked++;
        }
      }
    })();

    return linked;
  }

  // ── Contract Snapshots ───────────────────────────────────────────

  insertContractSnapshot(contractId: number, serviceId: number, input: {
    version: string | null;
    specPath: string;
    contentHash: string;
    endpointsJson: string;
    eventsJson: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO contract_snapshots (contract_id, service_id, version, spec_path, content_hash, endpoints_json, events_json, snapshot_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(contractId, serviceId, input.version, input.specPath, input.contentHash, input.endpointsJson, input.eventsJson, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  getContractSnapshots(contractId: number, limit = 50): ContractSnapshotRow[] {
    return this.db.prepare(
      'SELECT * FROM contract_snapshots WHERE contract_id = ? ORDER BY snapshot_at DESC LIMIT ?',
    ).all(contractId, limit) as ContractSnapshotRow[];
  }

  getLatestSnapshot(contractId: number): ContractSnapshotRow | undefined {
    return this.db.prepare(
      'SELECT * FROM contract_snapshots WHERE contract_id = ? ORDER BY snapshot_at DESC LIMIT 1',
    ).get(contractId) as ContractSnapshotRow | undefined;
  }

  getSnapshotsByService(serviceId: number, limit = 50): ContractSnapshotRow[] {
    return this.db.prepare(
      'SELECT * FROM contract_snapshots WHERE service_id = ? ORDER BY snapshot_at DESC LIMIT ?',
    ).all(serviceId, limit) as ContractSnapshotRow[];
  }

  // ── Subproject Stats ─────────────────────────────────────────────

  getSubprojectStats(): {
    repos: number;
    clientCalls: number;
    linkedCalls: number;
    crossRepoEdges: number;
  } {
    const cnt = (sql: string) => (this.db.prepare(sql).get() as { cnt: number }).cnt;
    return {
      repos: cnt('SELECT COUNT(*) as cnt FROM subprojects'),
      clientCalls: cnt('SELECT COUNT(*) as cnt FROM client_calls'),
      linkedCalls: cnt('SELECT COUNT(*) as cnt FROM client_calls WHERE matched_endpoint_id IS NOT NULL'),
      crossRepoEdges: cnt('SELECT COUNT(*) as cnt FROM cross_service_edges'),
    };
  }
}
