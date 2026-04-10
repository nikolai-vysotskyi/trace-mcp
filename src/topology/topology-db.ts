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

export interface FederatedRepoRow {
  id: number;
  name: string;
  repo_root: string;
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
-- FEDERATION — explicit multi-repo graph linking
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS federated_repos (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    repo_root       TEXT NOT NULL UNIQUE,
    db_path         TEXT,
    contract_paths  TEXT,
    added_at        TEXT NOT NULL,
    last_synced     TEXT,
    metadata        TEXT
);

CREATE TABLE IF NOT EXISTS client_calls (
    id              INTEGER PRIMARY KEY,
    source_repo_id  INTEGER NOT NULL REFERENCES federated_repos(id) ON DELETE CASCADE,
    target_repo_id  INTEGER REFERENCES federated_repos(id),
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
  let bestMatch: (EndpointRow & { service_name: string; confidence: number }) | null = null;
  let bestScore = 0;

  for (const ep of endpoints) {
    const normalizedEp = normalize(ep.path);

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

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(TOPOLOGY_DDL);
    this.migrate();
    logger.debug({ dbPath }, 'Topology database initialized');
  }

  private migrate(): void {
    const cols = (this.db.pragma('table_info(services)') as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('project_group')) {
      this.db.exec('ALTER TABLE services ADD COLUMN project_group TEXT');
    }
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

  // ── Federated Repos ───────────────────────────────────────────────

  upsertFederatedRepo(input: {
    name: string;
    repoRoot: string;
    dbPath?: string;
    contractPaths?: string[];
    metadata?: Record<string, unknown>;
  }): number {
    const existing = this.db.prepare('SELECT id FROM federated_repos WHERE repo_root = ?').get(input.repoRoot) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE federated_repos SET name = ?, db_path = COALESCE(?, db_path),
          contract_paths = COALESCE(?, contract_paths),
          metadata = COALESCE(?, metadata), last_synced = datetime('now')
        WHERE id = ?
      `).run(input.name, input.dbPath ?? null,
        input.contractPaths ? JSON.stringify(input.contractPaths) : null,
        input.metadata ? JSON.stringify(input.metadata) : null, existing.id);
      return existing.id;
    }

    return this.db.prepare(`
      INSERT INTO federated_repos (name, repo_root, db_path, contract_paths, metadata, added_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(input.name, input.repoRoot, input.dbPath ?? null,
      input.contractPaths ? JSON.stringify(input.contractPaths) : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ).lastInsertRowid as number;
  }

  getFederatedRepo(nameOrRoot: string): FederatedRepoRow | undefined {
    return (this.db.prepare('SELECT * FROM federated_repos WHERE name = ? OR repo_root = ?')
      .get(nameOrRoot, nameOrRoot) as FederatedRepoRow | undefined);
  }

  getAllFederatedRepos(): FederatedRepoRow[] {
    return this.db.prepare('SELECT * FROM federated_repos ORDER BY name').all() as FederatedRepoRow[];
  }

  deleteFederatedRepo(id: number): void {
    this.db.prepare('DELETE FROM federated_repos WHERE id = ?').run(id);
  }

  /**
   * Remove all topology data associated with a repo root:
   * federated_repos (+ cascading client_calls), services (+ cascading contracts,
   * endpoints, events, edges, snapshots).
   * Returns counts of deleted rows for logging.
   */
  removeByRepoRoot(repoRoot: string): { federatedRepos: number; services: number } {
    const result = { federatedRepos: 0, services: 0 };

    // Delete federated repo entry (cascades to client_calls)
    const fedRepo = this.getFederatedRepo(repoRoot);
    if (fedRepo) {
      this.deleteFederatedRepo(fedRepo.id);
      result.federatedRepos = 1;
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

  updateFederatedRepoSyncTime(id: number): void {
    this.db.prepare("UPDATE federated_repos SET last_synced = datetime('now') WHERE id = ?").run(id);
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
      JOIN federated_repos fr ON cc.source_repo_id = fr.id
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
      SELECT cc.*, fr.name as source_repo_name FROM client_calls cc
      JOIN federated_repos fr ON cc.source_repo_id = fr.id
      WHERE cc.target_repo_id = ?
      ORDER BY cc.confidence DESC
    `).all(targetRepoId) as Array<ClientCallRow & { source_repo_name: string }>;
  }

  /** Match unlinked client calls to known endpoints. Returns number of newly linked calls. */
  linkClientCallsToEndpoints(): number {
    // Match by URL pattern similarity
    const unlinked = this.db.prepare(
      'SELECT * FROM client_calls WHERE matched_endpoint_id IS NULL',
    ).all() as ClientCallRow[];

    const endpoints = this.getAllEndpoints();
    let linked = 0;

    const updateStmt = this.db.prepare(
      'UPDATE client_calls SET matched_endpoint_id = ?, target_repo_id = ?, confidence = ? WHERE id = ?',
    );

    this.db.transaction(() => {
      for (const call of unlinked) {
        const match = findBestEndpointMatch(call.url_pattern, call.method, endpoints);
        if (match) {
          // Find the repo for this service
          const svc = this.db.prepare('SELECT repo_root FROM services WHERE id = ?')
            .get(match.service_id) as { repo_root: string } | undefined;
          const targetRepo = svc
            ? this.db.prepare('SELECT id FROM federated_repos WHERE repo_root = ?')
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

  // ── Federation Stats ─────────────────────────────────────────────

  getFederationStats(): {
    repos: number;
    clientCalls: number;
    linkedCalls: number;
    crossRepoEdges: number;
  } {
    const cnt = (sql: string) => (this.db.prepare(sql).get() as { cnt: number }).cnt;
    return {
      repos: cnt('SELECT COUNT(*) as cnt FROM federated_repos'),
      clientCalls: cnt('SELECT COUNT(*) as cnt FROM client_calls'),
      linkedCalls: cnt('SELECT COUNT(*) as cnt FROM client_calls WHERE matched_endpoint_id IS NOT NULL'),
      crossRepoEdges: cnt('SELECT COUNT(*) as cnt FROM cross_service_edges'),
    };
  }
}
