/**
 * Topology row shapes — dependency-free leaf module.
 *
 * Extracted from `topology-db.ts` (Task: god-class decomposition of
 * `TopologyStore`). The per-entity operation modules (services, contracts,
 * endpoints, events, edges, subprojects, client-calls, snapshots) import these
 * types without closing an import cycle back through the store. `topology-db.ts`
 * re-exports every type below, so external callers keep importing row shapes
 * from `./topology-db.js` unchanged.
 */

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
