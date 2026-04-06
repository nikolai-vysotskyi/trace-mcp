/**
 * Federation MCP tools — cross-repo impact analysis and dependency graph.
 */

import { ok, err, type TraceMcpResult } from '../errors.js';
import { validationError } from '../errors.js';
import { FederationManager, type CrossRepoImpactResult, type FederationGraphResult } from '../federation/manager.js';
import type { TopologyStore } from '../topology/topology-db.js';

// ════════════════════════════════════════════════════════════════════════
// 1. FEDERATION GRAPH — show all federated repos and their connections
// ════════════════════════════════════════════════════════════════════════

export function getFederationGraph(
  topoStore: TopologyStore,
): TraceMcpResult<FederationGraphResult> {
  const manager = new FederationManager(topoStore);
  return ok(manager.list());
}

// ════════════════════════════════════════════════════════════════════════
// 2. FEDERATION IMPACT — cross-repo impact of changing an endpoint
// ════════════════════════════════════════════════════════════════════════

export function getFederationImpact(
  topoStore: TopologyStore,
  opts: { endpoint?: string; method?: string; service?: string },
): TraceMcpResult<CrossRepoImpactResult[]> {
  if (!opts.endpoint && !opts.service) {
    return err(validationError('At least one of endpoint or service is required'));
  }

  const manager = new FederationManager(topoStore);
  return ok(manager.getImpact(opts));
}

// ════════════════════════════════════════════════════════════════════════
// 3. FEDERATION ADD — add a repo to the federation (via MCP tool)
// ════════════════════════════════════════════════════════════════════════

export function federationAddRepo(
  topoStore: TopologyStore,
  opts: { repoPath: string; name?: string; contractPaths?: string[] },
): TraceMcpResult<{
  repo: string;
  name: string;
  services: number;
  endpoints: number;
  clientCalls: number;
  linkedCalls: number;
}> {
  try {
    const manager = new FederationManager(topoStore);
    const result = manager.add(opts.repoPath, {
      name: opts.name,
      contractPaths: opts.contractPaths,
    });
    return ok(result);
  } catch (e) {
    return err(validationError((e as Error).message));
  }
}

// ════════════════════════════════════════════════════════════════════════
// 4. FEDERATION SYNC — re-scan all federated repos
// ════════════════════════════════════════════════════════════════════════

export function federationSync(
  topoStore: TopologyStore,
): TraceMcpResult<{
  repos: number;
  servicesUpdated: number;
  endpointsUpdated: number;
  clientCallsScanned: number;
  newlyLinked: number;
  crossRepoEdges: number;
}> {
  const manager = new FederationManager(topoStore);
  const result = manager.sync();
  return ok(result);
}

// ════════════════════════════════════════════════════════════════════════
// 5. FEDERATION CLIENTS — find all client calls to a specific endpoint
// ════════════════════════════════════════════════════════════════════════

interface FederationClientCallsResult {
  endpoint: { method: string | null; path: string; service: string };
  clients: Array<{
    repo: string;
    filePath: string;
    line: number | null;
    callType: string;
    confidence: number;
  }>;
  totalClients: number;
}

export function getFederationClients(
  topoStore: TopologyStore,
  opts: { endpoint: string; method?: string },
): TraceMcpResult<FederationClientCallsResult[]> {
  const allEndpoints = topoStore.getAllEndpoints();
  const normalized = opts.endpoint.toLowerCase();

  const matchingEndpoints = allEndpoints.filter((ep) => {
    if (!ep.path.toLowerCase().includes(normalized)) return false;
    if (opts.method && ep.method?.toUpperCase() !== opts.method.toUpperCase()) return false;
    return true;
  });

  const results: FederationClientCallsResult[] = [];

  for (const ep of matchingEndpoints) {
    const clientCalls = topoStore.getClientCallsByEndpoint(ep.id);
    results.push({
      endpoint: {
        method: ep.method,
        path: ep.path,
        service: ep.service_name,
      },
      clients: clientCalls.map((c) => ({
        repo: c.source_repo_name,
        filePath: c.file_path,
        line: c.line,
        callType: c.call_type,
        confidence: c.confidence,
      })),
      totalClients: clientCalls.length,
    });
  }

  return ok(results);
}
