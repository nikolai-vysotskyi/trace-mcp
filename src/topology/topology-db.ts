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

export interface EventChannelRow {
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
`;

// ════════════════════════════════════════════════════════════════════════
// TOPOLOGY STORE
// ════════════════════════════════════════════════════════════════════════

export class TopologyStore {
  public readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(TOPOLOGY_DDL);
    logger.debug({ dbPath }, 'Topology database initialized');
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
    metadata?: Record<string, unknown>;
  }): number {
    const existing = this.db.prepare('SELECT id FROM services WHERE name = ?').get(input.name) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE services SET repo_root = ?, db_path = ?, service_type = COALESCE(?, service_type),
          detection_source = COALESCE(?, detection_source), metadata = COALESCE(?, metadata),
          indexed_at = datetime('now')
        WHERE id = ?
      `).run(input.repoRoot, input.dbPath, input.serviceType ?? null, input.detectionSource ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null, existing.id);
      return existing.id;
    }

    return this.db.prepare(`
      INSERT INTO services (name, repo_root, db_path, service_type, detection_source, metadata, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(input.name, input.repoRoot, input.dbPath, input.serviceType ?? null,
      input.detectionSource ?? null, input.metadata ? JSON.stringify(input.metadata) : null,
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
}
