/**
 * Subproject MCP tools — cross-repo impact analysis and dependency graph.
 */

import { ok, err, type TraceMcpResult } from '../../errors.js';
import { validationError, notFound } from '../../errors.js';
import { SubprojectManager, type CrossRepoImpactResult, type SubprojectGraphResult } from '../../subproject/manager.js';
import type { TopologyStore } from '../../topology/topology-db.js';
import { diffEndpoints, type EndpointSchemaDiff } from '../../subproject/schema-diff.js';

// ════════════════════════════════════════════════════════════════════════
// 1. SUBPROJECT GRAPH — show all subprojects and their connections
// ════════════════════════════════════════════════════════════════════════

export function getSubprojectGraph(
  topoStore: TopologyStore,
): TraceMcpResult<SubprojectGraphResult> {
  const manager = new SubprojectManager(topoStore);
  return ok(manager.list());
}

// ════════════════════════════════════════════════════════════════════════
// 2. SUBPROJECT IMPACT — cross-repo impact of changing an endpoint
// ════════════════════════════════════════════════════════════════════════

export function getSubprojectImpact(
  topoStore: TopologyStore,
  opts: { endpoint?: string; method?: string; service?: string },
): TraceMcpResult<CrossRepoImpactResult[]> {
  if (!opts.endpoint && !opts.service) {
    return err(validationError('At least one of endpoint or service is required'));
  }

  const manager = new SubprojectManager(topoStore);
  return ok(manager.getImpact(opts));
}

// ════════════════════════════════════════════════════════════════════════
// 3. SUBPROJECT ADD — add a repo as a subproject (via MCP tool)
// ════════════════════════════════════════════════════════════════════════

export function subprojectAddRepo(
  topoStore: TopologyStore,
  opts: { repoPath: string; projectRoot: string; name?: string; contractPaths?: string[] },
): TraceMcpResult<{
  repo: string;
  name: string;
  services: number;
  endpoints: number;
  clientCalls: number;
  linkedCalls: number;
}> {
  try {
    const manager = new SubprojectManager(topoStore);
    const result = manager.add(opts.repoPath, opts.projectRoot, {
      name: opts.name,
      contractPaths: opts.contractPaths,
    });
    return ok(result);
  } catch (e) {
    return err(validationError((e as Error).message));
  }
}

// ════════════════════════════════════════════════════════════════════════
// 4. SUBPROJECT SYNC — re-scan all subprojects
// ════════════════════════════════════════════════════════════════════════

export function subprojectSync(
  topoStore: TopologyStore,
): TraceMcpResult<{
  repos: number;
  servicesUpdated: number;
  endpointsUpdated: number;
  clientCallsScanned: number;
  newlyLinked: number;
  crossRepoEdges: number;
}> {
  const manager = new SubprojectManager(topoStore);
  const result = manager.sync();
  return ok(result);
}

// ════════════════════════════════════════════════════════════════════════
// 5. SUBPROJECT CLIENTS — find all client calls to a specific endpoint
// ════════════════════════════════════════════════════════════════════════

interface SubprojectClientCallsResult {
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

export function getSubprojectClients(
  topoStore: TopologyStore,
  opts: { endpoint: string; method?: string },
): TraceMcpResult<SubprojectClientCallsResult[]> {
  const allEndpoints = topoStore.getAllEndpoints();
  const normalized = opts.endpoint.toLowerCase();

  const matchingEndpoints = allEndpoints.filter((ep) => {
    if (!ep.path.toLowerCase().includes(normalized)) return false;
    if (opts.method && ep.method?.toUpperCase() !== opts.method.toUpperCase()) return false;
    return true;
  });

  const results: SubprojectClientCallsResult[] = [];

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

// ════════════════════════════════════════════════════════════════════════
// 6. CONTRACT VERSIONS — version history with breaking change detection
// ════════════════════════════════════════════════════════════════════════

interface ContractVersionEntry {
  version: string | null;
  specPath: string;
  snapshotAt: string;
  endpointCount: number;
  diffs?: EndpointSchemaDiff[];
}

interface ContractVersionsResult {
  service: string;
  versions: ContractVersionEntry[];
  totalBreakingChanges: number;
}

export function getContractVersions(
  topoStore: TopologyStore,
  opts: { service: string; limit?: number },
): TraceMcpResult<ContractVersionsResult> {
  const svc = topoStore.getService(opts.service);
  if (!svc) {
    return err(notFound(opts.service, topoStore.getAllServices().map((s) => s.name)));
  }

  const snapshots = topoStore.getSnapshotsByService(svc.id, opts.limit ?? 10);
  const versions: ContractVersionEntry[] = [];
  let totalBreakingChanges = 0;

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    let parsedEndpoints: Array<{ method: string | null; path: string; requestSchema?: string; responseSchema?: string }> = [];
    try {
      const parsed = JSON.parse(snap.endpoints_json) as { endpoints?: Array<{ method?: string; path: string; requestSchema?: string; responseSchema?: string }> };
      parsedEndpoints = (parsed.endpoints ?? []).map((e) => ({ method: e.method ?? null, path: e.path, requestSchema: e.requestSchema, responseSchema: e.responseSchema }));
    } catch { /* malformed JSON */ }

    const entry: ContractVersionEntry = {
      version: snap.version,
      specPath: snap.spec_path,
      snapshotAt: snap.snapshot_at,
      endpointCount: parsedEndpoints.length,
    };

    // Diff with the next (older) snapshot
    if (i + 1 < snapshots.length) {
      const olderSnap = snapshots[i + 1];
      let olderEndpoints: Array<{ method: string | null; path: string; requestSchema?: string; responseSchema?: string }> = [];
      try {
        const parsed = JSON.parse(olderSnap.endpoints_json) as { endpoints?: Array<{ method?: string; path: string; requestSchema?: string; responseSchema?: string }> };
        olderEndpoints = (parsed.endpoints ?? []).map((e) => ({ method: e.method ?? null, path: e.path, requestSchema: e.requestSchema, responseSchema: e.responseSchema }));
      } catch { /* malformed JSON */ }

      const diffs = diffEndpoints(olderEndpoints, parsedEndpoints);
      if (diffs.length > 0) {
        entry.diffs = diffs;
        totalBreakingChanges += diffs.filter((d) => d.breaking).length;
      }
    }

    versions.push(entry);
  }

  return ok({ service: svc.name, versions, totalBreakingChanges });
}
