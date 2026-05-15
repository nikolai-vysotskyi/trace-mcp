/**
 * Multi-Repo Topology tools:
 * - get_service_map: all services + APIs + inter-service dependencies
 * - get_cross_service_impact: impact of changing an endpoint/event
 * - get_api_contract: API contract for a service
 * - get_service_dependencies: outgoing/incoming service dependencies
 * - get_contract_drift: spec vs implementation mismatches
 */

import { err, notFound, ok, type TraceMcpResult } from '../../errors.js';
import { getDbPath } from '../../global.js';
import { diffEndpoints, type EndpointSchemaDiff } from '../../subproject/schema-diff.js';
import { parseContracts } from '../../topology/contract-parser.js';
import { detectServices } from '../../topology/service-detector.js';
import type { TopologyStore } from '../../topology/topology-db.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface ServiceMapResult {
  services: Array<{
    name: string;
    type: string | null;
    detection_source: string | null;
    endpoint_count: number;
    event_count: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    edge_type: string;
    confidence: number;
  }>;
  stats: {
    services: number;
    contracts: number;
    endpoints: number;
    events: number;
    crossEdges: number;
  };
}

interface CrossServiceImpactResult {
  target: { service: string; endpoint?: string; event?: string };
  affected_services: Array<{
    name: string;
    impact_type: string;
    confidence: number;
    details: string;
  }>;
  risk_level: 'low' | 'medium' | 'high';
}

interface ApiContractResult {
  service: string;
  contracts: Array<{
    type: string;
    spec_path: string;
    version: string | null;
    endpoint_count: number;
  }>;
  endpoints: Array<{ method: string | null; path: string; operation_id: string | null }>;
  events: Array<{ channel: string; direction: string }>;
}

interface ServiceDepsResult {
  service: string;
  outgoing: Array<{ target: string; edge_type: string; count: number }>;
  incoming: Array<{ source: string; edge_type: string; count: number }>;
}

interface ContractDriftResult {
  service: string;
  drifts: Array<{
    type: 'missing_endpoint' | 'extra_endpoint' | 'unmatched_spec' | 'schema_breaking_change';
    detail: string;
  }>;
  schemaChanges?: EndpointSchemaDiff[];
}

// ════════════════════════════════════════════════════════════════════════
// TOPOLOGY BUILD (lazy, on first tool call)
// ════════════════════════════════════════════════════════════════════════

function ensureTopologyBuilt(
  topoStore: TopologyStore,
  projectRoot: string,
  additionalRepos: string[],
): void {
  if (topoStore.getAllServices().length > 0) return;

  // Auto-detect services from project root and additional repos
  const repos = [projectRoot, ...additionalRepos];
  const detected = detectServices(repos);

  for (const svc of detected) {
    const dbPath = getDbPath(svc.repoRoot);
    const serviceId = topoStore.upsertService({
      name: svc.name,
      repoRoot: svc.repoRoot,
      dbPath,
      serviceType: svc.serviceType,
      detectionSource: svc.detectionSource,
      metadata: svc.metadata,
    });

    // Parse contracts
    const contracts = parseContracts(svc.repoRoot);
    for (const contract of contracts) {
      const contractId = topoStore.insertContract(serviceId, {
        contractType: contract.type,
        specPath: contract.specPath,
        version: contract.version,
        parsedSpec: JSON.stringify({ endpoints: contract.endpoints, events: contract.events }),
      });

      topoStore.insertEndpoints(
        contractId,
        serviceId,
        contract.endpoints.map((e) => ({
          method: e.method ?? undefined,
          path: e.path,
          operationId: e.operationId,
        })),
      );

      if (contract.events.length > 0) {
        topoStore.insertEventChannels(
          contractId,
          serviceId,
          contract.events.map((e) => ({
            channelName: e.channelName,
            direction: e.direction,
          })),
        );
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// 1. GET SERVICE MAP
// ════════════════════════════════════════════════════════════════════════

export function getServiceMap(
  topoStore: TopologyStore,
  projectRoot: string,
  additionalRepos: string[],
  opts: { includeEndpoints?: boolean } = {},
): TraceMcpResult<ServiceMapResult> {
  ensureTopologyBuilt(topoStore, projectRoot, additionalRepos);

  // Single query for service counts instead of N+1 per service
  const serviceCounts = topoStore.db
    .prepare(`
    SELECT s.id, s.name, s.service_type, s.detection_source,
      (SELECT COUNT(*) FROM api_endpoints WHERE service_id = s.id) as endpoint_count,
      (SELECT COUNT(*) FROM event_channels WHERE service_id = s.id) as event_count
    FROM services s ORDER BY s.name
  `)
    .all() as Array<{
    id: number;
    name: string;
    service_type: string | null;
    detection_source: string | null;
    endpoint_count: number;
    event_count: number;
  }>;

  const edges = topoStore.getAllCrossServiceEdges();
  const stats = topoStore.getTopologyStats();

  return ok({
    services: serviceCounts.map((s) => ({
      name: s.name,
      type: s.service_type,
      detection_source: s.detection_source,
      endpoint_count: s.endpoint_count,
      event_count: s.event_count,
    })),
    edges: edges.map((e) => ({
      source: e.source_name,
      target: e.target_name,
      edge_type: e.edge_type,
      confidence: e.confidence,
    })),
    stats,
  });
}

// ════════════════════════════════════════════════════════════════════════
// 2. GET CROSS-SERVICE IMPACT
// ════════════════════════════════════════════════════════════════════════

export function getCrossServiceImpact(
  topoStore: TopologyStore,
  projectRoot: string,
  additionalRepos: string[],
  opts: { service: string; endpoint?: string; event?: string },
): TraceMcpResult<CrossServiceImpactResult> {
  ensureTopologyBuilt(topoStore, projectRoot, additionalRepos);

  const svc = topoStore.getService(opts.service);
  if (!svc) {
    return err(
      notFound(
        opts.service,
        topoStore.getAllServices().map((s) => s.name),
      ),
    );
  }

  const affected: CrossServiceImpactResult['affected_services'] = [];

  if (opts.endpoint) {
    // Find services that consume this endpoint
    const edges = topoStore
      .getAllCrossServiceEdges()
      .filter((e) => e.target_service_id === svc.id && e.target_ref?.includes(opts.endpoint!));
    for (const e of edges) {
      affected.push({
        name: e.source_name,
        impact_type: e.edge_type,
        confidence: e.confidence,
        details: `Calls ${opts.endpoint} via ${e.edge_type}`,
      });
    }
  }

  if (opts.event) {
    // Find subscribers for this event
    const events = topoStore.matchProducersConsumers();
    const matching = events.find((e) => e.channel === opts.event);
    if (matching) {
      for (const sub of matching.subscribers) {
        if (sub !== opts.service) {
          affected.push({
            name: sub,
            impact_type: 'subscribes_event',
            confidence: 1.0,
            details: `Subscribes to event '${opts.event}'`,
          });
        }
      }
    }
  }

  // If neither endpoint nor event specified, show all consumers of this service
  if (!opts.endpoint && !opts.event) {
    const incomingEdges = topoStore.getEdgesByTarget(svc.id);
    for (const e of incomingEdges) {
      affected.push({
        name: e.source_name,
        impact_type: e.edge_type,
        confidence: e.confidence,
        details: `Depends on ${opts.service} via ${e.edge_type}`,
      });
    }
  }

  const riskLevel = affected.length >= 3 ? 'high' : affected.length >= 1 ? 'medium' : 'low';

  return ok({
    target: { service: opts.service, endpoint: opts.endpoint, event: opts.event },
    affected_services: affected,
    risk_level: riskLevel,
  });
}

// ════════════════════════════════════════════════════════════════════════
// 3. GET API CONTRACT
// ════════════════════════════════════════════════════════════════════════

export function getApiContract(
  topoStore: TopologyStore,
  projectRoot: string,
  additionalRepos: string[],
  opts: { service: string; contractType?: string },
): TraceMcpResult<ApiContractResult> {
  ensureTopologyBuilt(topoStore, projectRoot, additionalRepos);

  const svc = topoStore.getService(opts.service);
  if (!svc) {
    return err(
      notFound(
        opts.service,
        topoStore.getAllServices().map((s) => s.name),
      ),
    );
  }

  let contracts = topoStore.getContractsByService(svc.id);
  if (opts.contractType) {
    contracts = contracts.filter((c) => c.contract_type === opts.contractType);
  }

  const allEndpoints = topoStore.getEndpointsByService(svc.id);
  // When a contractType filter is applied, endpoints must also be scoped to
  // the filtered contracts. Otherwise contracts narrow to (e.g.) openapi but
  // endpoints still include graphql/gRPC rows from the same service.
  const endpoints = opts.contractType
    ? allEndpoints.filter((e) => contracts.some((c) => c.id === e.contract_id))
    : allEndpoints;
  const events = topoStore.getEventsByService(svc.id);

  return ok({
    service: svc.name,
    contracts: contracts.map((c) => ({
      type: c.contract_type,
      spec_path: c.spec_path,
      version: c.version,
      endpoint_count: endpoints.filter((e) => e.contract_id === c.id).length,
    })),
    endpoints: endpoints.map((e) => ({
      method: e.method,
      path: e.path,
      operation_id: e.operation_id,
    })),
    events: events.map((e) => ({
      channel: e.channel_name,
      direction: e.direction,
    })),
  });
}

// ════════════════════════════════════════════════════════════════════════
// 4. GET SERVICE DEPENDENCIES
// ════════════════════════════════════════════════════════════════════════

export function getServiceDependencies(
  topoStore: TopologyStore,
  projectRoot: string,
  additionalRepos: string[],
  opts: { service: string; direction?: 'outgoing' | 'incoming' | 'both' },
): TraceMcpResult<ServiceDepsResult> {
  ensureTopologyBuilt(topoStore, projectRoot, additionalRepos);

  const svc = topoStore.getService(opts.service);
  if (!svc) {
    return err(
      notFound(
        opts.service,
        topoStore.getAllServices().map((s) => s.name),
      ),
    );
  }

  const direction = opts.direction ?? 'both';
  const outgoing: ServiceDepsResult['outgoing'] = [];
  const incoming: ServiceDepsResult['incoming'] = [];

  if (direction === 'outgoing' || direction === 'both') {
    const edges = topoStore.getEdgesBySource(svc.id);
    const grouped = new Map<string, { target: string; edgeType: string; count: number }>();
    for (const e of edges) {
      const key = `${e.target_name}|${e.edge_type}`;
      if (!grouped.has(key))
        grouped.set(key, { target: e.target_name, edgeType: e.edge_type, count: 0 });
      grouped.get(key)!.count++;
    }
    outgoing.push(
      ...[...grouped.values()].map((g) => ({
        target: g.target,
        edge_type: g.edgeType,
        count: g.count,
      })),
    );
  }

  if (direction === 'incoming' || direction === 'both') {
    const edges = topoStore.getEdgesByTarget(svc.id);
    const grouped = new Map<string, { source: string; edgeType: string; count: number }>();
    for (const e of edges) {
      const key = `${e.source_name}|${e.edge_type}`;
      if (!grouped.has(key))
        grouped.set(key, { source: e.source_name, edgeType: e.edge_type, count: 0 });
      grouped.get(key)!.count++;
    }
    incoming.push(
      ...[...grouped.values()].map((g) => ({
        source: g.source,
        edge_type: g.edgeType,
        count: g.count,
      })),
    );
  }

  return ok({ service: svc.name, outgoing, incoming });
}

// ════════════════════════════════════════════════════════════════════════
// 5. GET CONTRACT DRIFT
// ════════════════════════════════════════════════════════════════════════

export function getContractDrift(
  topoStore: TopologyStore,
  store: { getAllRoutes(): Array<{ method: string; uri: string }> },
  projectRoot: string,
  additionalRepos: string[],
  opts: { service: string },
): TraceMcpResult<ContractDriftResult> {
  ensureTopologyBuilt(topoStore, projectRoot, additionalRepos);

  const svc = topoStore.getService(opts.service);
  if (!svc) {
    return err(
      notFound(
        opts.service,
        topoStore.getAllServices().map((s) => s.name),
      ),
    );
  }

  const specEndpoints = topoStore.getEndpointsByService(svc.id);
  const implRoutes = store.getAllRoutes();
  const drifts: ContractDriftResult['drifts'] = [];

  // Check: spec endpoints missing from implementation
  for (const ep of specEndpoints) {
    const found = implRoutes.some(
      (r) => r.uri === ep.path && (!ep.method || r.method === ep.method),
    );
    if (!found) {
      drifts.push({
        type: 'missing_endpoint',
        detail: `${ep.method ?? '*'} ${ep.path} defined in spec but not found in implementation`,
      });
    }
  }

  // Check: implementation routes not in spec
  if (specEndpoints.length > 0) {
    for (const route of implRoutes) {
      const found = specEndpoints.some(
        (ep) => ep.path === route.uri && (!ep.method || ep.method === route.method),
      );
      if (!found) {
        drifts.push({
          type: 'extra_endpoint',
          detail: `${route.method} ${route.uri} exists in implementation but not in spec`,
        });
      }
    }
  }

  // Schema-level drift: compare current endpoints to latest snapshot
  const contracts = topoStore.getContractsByService(svc.id);
  let schemaChanges: EndpointSchemaDiff[] | undefined;

  for (const contract of contracts) {
    const latestSnapshot = topoStore.getLatestSnapshot(contract.id);
    if (!latestSnapshot) continue;

    // Parse snapshot endpoints
    let oldEndpoints: Array<{
      method: string | null;
      path: string;
      requestSchema?: string;
      responseSchema?: string;
    }> = [];
    try {
      const parsed = JSON.parse(latestSnapshot.endpoints_json) as {
        endpoints?: Array<{
          method?: string;
          path: string;
          requestSchema?: string;
          responseSchema?: string;
        }>;
      };
      oldEndpoints = (parsed.endpoints ?? []).map((e) => ({
        method: e.method ?? null,
        path: e.path,
        requestSchema: e.requestSchema,
        responseSchema: e.responseSchema,
      }));
    } catch {
      continue;
    }

    // Current endpoints with schemas
    const currentEndpoints = specEndpoints.map((ep) => ({
      method: ep.method,
      path: ep.path,
      requestSchema: ep.request_schema,
      responseSchema: ep.response_schema,
    }));

    const epDiffs = diffEndpoints(oldEndpoints, currentEndpoints);
    if (epDiffs.length > 0) {
      schemaChanges = (schemaChanges ?? []).concat(epDiffs);
      for (const epDiff of epDiffs) {
        if (epDiff.breaking) {
          const allChanges = [...epDiff.requestChanges, ...epDiff.responseChanges].filter(
            (c) => c.breaking,
          );
          for (const change of allChanges) {
            drifts.push({
              type: 'schema_breaking_change',
              detail: `${epDiff.endpoint.method ?? '*'} ${epDiff.endpoint.path}: ${change.type} at ${change.path}${change.oldValue ? ` (was: ${change.oldValue})` : ''}${change.newValue ? ` (now: ${change.newValue})` : ''}`,
            });
          }
        }
      }
    }
  }

  return ok({ service: svc.name, drifts, schemaChanges });
}
