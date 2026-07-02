/**
 * Topology Store — manages the cross-service topology database (~/.trace-mcp/topology.db).
 * Separate from per-repo DBs. Stores services, API contracts, endpoints, events, and cross-service edges.
 *
 * This class is a thin façade over per-entity operation modules
 * (`topology-services`, `topology-contracts`, `topology-endpoints`,
 * `topology-events`, `topology-edges`, `topology-subprojects`,
 * `topology-client-calls`, `topology-snapshots`). Schema lifecycle
 * (constructor / preMigrate / migrate / runOnce / close) stays here; every
 * entity method delegates to its module. Row shapes live in the dependency-free
 * leaf `topology-types` and are re-exported below for public-API back-compat.
 */

import Database from 'better-sqlite3';
import { logger } from '../logger.js';
import { restrictDbPerms } from '../shared/db-perms.js';
import { ServiceOperations } from './topology-services.js';
import { ContractOperations } from './topology-contracts.js';
import { EndpointOperations } from './topology-endpoints.js';
import { EventOperations } from './topology-events.js';
import { CrossServiceEdgeOperations } from './topology-edges.js';
import { SubprojectOperations } from './topology-subprojects.js';
import { ClientCallOperations } from './topology-client-calls.js';
import { SnapshotOperations } from './topology-snapshots.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

// Row shapes live in `topology-types.ts` so the extracted per-entity operation
// modules can import them without closing an import cycle back through this
// store. Re-exported here to preserve the public API — external callers keep
// importing row types from `./topology-db.js`.
export type {
  ServiceRow,
  ContractRow,
  EndpointRow,
  EventChannelRow,
  CrossServiceEdgeRow,
  SubprojectRow,
  ClientCallRow,
  ContractSnapshotRow,
} from './topology-types.js';
import type {
  ServiceRow,
  ContractRow,
  EndpointRow,
  EventChannelRow,
  CrossServiceEdgeRow,
  SubprojectRow,
  ClientCallRow,
  ContractSnapshotRow,
} from './topology-types.js';

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

export class TopologyStore {
  public readonly db: Database.Database;

  private readonly services: ServiceOperations;
  private readonly contracts: ContractOperations;
  private readonly endpoints: EndpointOperations;
  private readonly events: EventOperations;
  private readonly edges: CrossServiceEdgeOperations;
  private readonly subprojects: SubprojectOperations;
  private readonly clientCalls: ClientCallOperations;
  private readonly snapshots: SnapshotOperations;

  constructor(dbPath: string, opts?: { readonly?: boolean }) {
    this.db = new Database(dbPath, { readonly: opts?.readonly ?? false });
    if (opts?.readonly) {
      this.db.pragma('busy_timeout = 5000');
      logger.debug({ dbPath, readonly: true }, 'Topology database opened (readonly)');
    } else {
      restrictDbPerms(dbPath);
      this.db.pragma('journal_mode = WAL');

      this.db.pragma(`journal_size_limit = ${100 * 1024 * 1024}`);
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.preMigrate();
      this.db.exec(TOPOLOGY_DDL);
      this.migrate();
      logger.debug({ dbPath }, 'Topology database initialized');
    }

    // Per-entity operation modules — each takes the raw DB handle; the two that
    // read across entities receive a small callback deps object instead of
    // importing sibling op classes (which would risk an import cycle).
    this.services = new ServiceOperations(this.db);
    this.contracts = new ContractOperations(this.db);
    this.endpoints = new EndpointOperations(this.db);
    this.events = new EventOperations(this.db);
    this.edges = new CrossServiceEdgeOperations(this.db);
    this.subprojects = new SubprojectOperations(this.db, {
      deleteService: (id) => this.services.deleteService(id),
    });
    this.clientCalls = new ClientCallOperations(this.db, {
      getAllEndpoints: () => this.endpoints.getAllEndpoints(),
      getAllServices: () => this.services.getAllServices(),
      getAllSubprojects: () => this.subprojects.getAllSubprojects(),
    });
    this.snapshots = new SnapshotOperations(this.db);
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
      const cols = (this.db.pragma('table_info(subprojects)') as Array<{ name: string }>).map(
        (c) => c.name,
      );
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
    const cols = (this.db.pragma('table_info(services)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    if (!cols.includes('project_group')) {
      this.db.exec('ALTER TABLE services ADD COLUMN project_group TEXT');
    }

    // Migration: subprojects table requires project_root column.
    // Drop all old data and let auto-sync rebuild it correctly.
    const subCols = (this.db.pragma('table_info(subprojects)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
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
      const services = this.db
        .prepare(
          `SELECT DISTINCT service_id FROM api_contracts WHERE contract_type = 'framework_routes'`,
        )
        .all() as Array<{ service_id: number }>;

      let deletedContracts = 0;
      let deletedEndpoints = 0;

      for (const { service_id } of services) {
        // Find the latest contract (highest id) per service
        const latest = this.db
          .prepare(
            `SELECT id FROM api_contracts WHERE service_id = ? AND contract_type = 'framework_routes' ORDER BY id DESC LIMIT 1`,
          )
          .get(service_id) as { id: number } | undefined;

        if (!latest) continue;

        // Delete all older framework_routes contracts (cascade deletes their endpoints)
        const result = this.db
          .prepare(
            `DELETE FROM api_contracts WHERE service_id = ? AND contract_type = 'framework_routes' AND id != ?`,
          )
          .run(service_id, latest.id);
        deletedContracts += result.changes;

        // Delete non-HTTP endpoints from the remaining contract
        const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'];
        const placeholders = httpMethods.map(() => '?').join(',');
        const epResult = this.db
          .prepare(
            `DELETE FROM api_endpoints WHERE contract_id = ? AND method IS NOT NULL AND method NOT IN (${placeholders})`,
          )
          .run(latest.id, ...httpMethods);
        deletedEndpoints += epResult.changes;
      }

      if (deletedContracts > 0 || deletedEndpoints > 0) {
        logger.info(
          { deletedContracts, deletedEndpoints },
          'Migration: cleaned duplicate contracts and non-HTTP endpoints',
        );
      }
    });

    // Migration: clear stale cross_service_edges that pointed to non-HTTP endpoints.
    // These were created when services had 230K+ fake endpoints (TEST/TOOL/CLI/JOB routes).
    // All edges need to be rebuilt from scratch after topology data is cleaned.
    this.runOnce('rebuild_cross_service_edges_v1', () => {
      const result = this.db.prepare('DELETE FROM cross_service_edges').run();
      if (result.changes > 0) {
        logger.info(
          { deleted: result.changes },
          'Migration: cleared stale cross-service edges for rebuild',
        );
      }
    });

    // Migration: rebuild client_calls table to fix FK references.
    // Legacy table referenced federated_repos(id) which no longer exists.
    // Must recreate with subprojects(id) references.
    this.runOnce('fix_client_calls_fk_v1', () => {
      const hasLegacyFk = (
        this.db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='client_calls'")
          .get() as { sql: string } | undefined
      )?.sql?.includes('federated_repos');

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
        logger.info(
          'Migration: rebuilt client_calls with correct FK references (subprojects instead of federated_repos)',
        );
      }
    });
  }

  /** Run a migration block exactly once, tracked by key in topology_meta. */
  private runOnce(key: string, fn: () => void): void {
    const existing = this.db.prepare('SELECT value FROM topology_meta WHERE key = ?').get(key);
    if (existing) return;
    fn();
    this.db
      .prepare('INSERT OR REPLACE INTO topology_meta (key, value) VALUES (?, ?)')
      .run(key, new Date().toISOString());
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
    return this.services.upsertService(input);
  }

  getService(name: string): ServiceRow | undefined {
    return this.services.getService(name);
  }

  getAllServices(): ServiceRow[] {
    return this.services.getAllServices();
  }

  updateServiceGroup(serviceId: number, projectGroup: string | null): void {
    this.services.updateServiceGroup(serviceId, projectGroup);
  }

  getServicesWithEndpointCounts(
    projectRoot?: string,
  ): Array<ServiceRow & { endpoint_count: number }> {
    return this.services.getServicesWithEndpointCounts(projectRoot);
  }

  deleteService(id: number): void {
    this.services.deleteService(id);
  }

  // ── Contracts ────────────────────────────────────────────────────────

  insertContract(
    serviceId: number,
    input: {
      contractType: string;
      specPath: string;
      version?: string;
      contentHash?: string;
      parsedSpec: string;
    },
  ): number {
    return this.contracts.insertContract(serviceId, input);
  }

  getContractsByService(serviceId: number): ContractRow[] {
    return this.contracts.getContractsByService(serviceId);
  }

  deleteContractsByService(serviceId: number): void {
    this.contracts.deleteContractsByService(serviceId);
  }

  // ── Endpoints ────────────────────────────────────────────────────────

  insertEndpoints(
    contractId: number,
    serviceId: number,
    endpoints: Array<{
      method?: string;
      path: string;
      operationId?: string;
      requestSchema?: string;
      responseSchema?: string;
      metadata?: Record<string, unknown>;
    }>,
  ): void {
    this.endpoints.insertEndpoints(contractId, serviceId, endpoints);
  }

  getEndpointsByService(serviceId: number): EndpointRow[] {
    return this.endpoints.getEndpointsByService(serviceId);
  }

  findEndpointByPath(
    pathQuery: string,
    method?: string,
  ): Array<EndpointRow & { service_name: string }> {
    return this.endpoints.findEndpointByPath(pathQuery, method);
  }

  getAllEndpoints(): Array<EndpointRow & { service_name: string }> {
    return this.endpoints.getAllEndpoints();
  }

  // ── Event Channels ──────────────────────────────────────────────────

  insertEventChannels(
    contractId: number | null,
    serviceId: number,
    channels: Array<{
      channelName: string;
      direction: 'publish' | 'subscribe';
      payloadSchema?: string;
    }>,
  ): void {
    this.events.insertEventChannels(contractId, serviceId, channels);
  }

  getEventsByService(serviceId: number): EventChannelRow[] {
    return this.events.getEventsByService(serviceId);
  }

  matchProducersConsumers(): Array<{
    channel: string;
    publishers: string[];
    subscribers: string[];
  }> {
    return this.events.matchProducersConsumers();
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
    return this.edges.insertCrossServiceEdge(input);
  }

  getAllCrossServiceEdges(): Array<
    CrossServiceEdgeRow & { source_name: string; target_name: string }
  > {
    return this.edges.getAllCrossServiceEdges();
  }

  getEdgesBySource(serviceId: number): Array<CrossServiceEdgeRow & { target_name: string }> {
    return this.edges.getEdgesBySource(serviceId);
  }

  getEdgesByTarget(serviceId: number): Array<CrossServiceEdgeRow & { source_name: string }> {
    return this.edges.getEdgesByTarget(serviceId);
  }

  // ── Stats ──────────────────────────────────────────────────────────

  getTopologyStats(): {
    services: number;
    contracts: number;
    endpoints: number;
    events: number;
    crossEdges: number;
  } {
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
    return this.subprojects.upsertSubproject(input);
  }

  getSubproject(nameOrRoot: string, projectRoot?: string): SubprojectRow | undefined {
    return this.subprojects.getSubproject(nameOrRoot, projectRoot);
  }

  getSubprojectsByProject(projectRoot: string): SubprojectRow[] {
    return this.subprojects.getSubprojectsByProject(projectRoot);
  }

  getAllSubprojects(): SubprojectRow[] {
    return this.subprojects.getAllSubprojects();
  }

  deleteSubproject(id: number): void {
    this.subprojects.deleteSubproject(id);
  }

  /**
   * Remove all topology data associated with a repo root:
   * subprojects (+ cascading client_calls), services (+ cascading contracts,
   * endpoints, events, edges, snapshots).
   * Returns counts of deleted rows for logging.
   */
  removeByRepoRoot(repoRoot: string): { subprojects: number; services: number } {
    return this.subprojects.removeByRepoRoot(repoRoot);
  }

  updateSubprojectSyncTime(id: number): void {
    this.subprojects.updateSubprojectSyncTime(id);
  }

  // ── Client Calls ──────────────────────────────────────────────────

  insertClientCalls(
    calls: Array<{
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
    }>,
  ): void {
    this.clientCalls.insertClientCalls(calls);
  }

  deleteClientCallsByRepo(repoId: number): void {
    this.clientCalls.deleteClientCallsByRepo(repoId);
  }

  getClientCallsByEndpoint(
    endpointId: number,
  ): Array<ClientCallRow & { source_repo_name: string }> {
    return this.clientCalls.getClientCallsByEndpoint(endpointId);
  }

  getClientCallsByRepo(repoId: number): ClientCallRow[] {
    return this.clientCalls.getClientCallsByRepo(repoId);
  }

  getClientCallsForTarget(
    targetRepoId: number,
  ): Array<ClientCallRow & { source_repo_name: string }> {
    return this.clientCalls.getClientCallsForTarget(targetRepoId);
  }

  /** Match unlinked client calls to known endpoints. Returns number of newly linked calls. */
  linkClientCallsToEndpoints(): number {
    return this.clientCalls.linkClientCallsToEndpoints();
  }

  // ── Contract Snapshots ───────────────────────────────────────────

  insertContractSnapshot(
    contractId: number,
    serviceId: number,
    input: {
      version: string | null;
      specPath: string;
      contentHash: string;
      endpointsJson: string;
      eventsJson: string;
    },
  ): number {
    return this.snapshots.insertContractSnapshot(contractId, serviceId, input);
  }

  getContractSnapshots(contractId: number, limit = 50): ContractSnapshotRow[] {
    return this.snapshots.getContractSnapshots(contractId, limit);
  }

  getLatestSnapshot(contractId: number): ContractSnapshotRow | undefined {
    return this.snapshots.getLatestSnapshot(contractId);
  }

  getSnapshotsByService(serviceId: number, limit = 50): ContractSnapshotRow[] {
    return this.snapshots.getSnapshotsByService(serviceId, limit);
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
      linkedCalls: cnt(
        'SELECT COUNT(*) as cnt FROM client_calls WHERE matched_endpoint_id IS NOT NULL',
      ),
      crossRepoEdges: cnt('SELECT COUNT(*) as cnt FROM cross_service_edges'),
    };
  }
}
