/**
 * Federation Impact — one-call aggregation of cross-repo blast radius.
 *
 * Combines subproject client-call impact (SubprojectManager.getImpact),
 * cross-service edge impact (getCrossServiceImpact), and contract drift
 * (getContractDrift) into a single response so callers don't have to
 * manually chain 3-4 topology tools to answer "if I change X, what
 * breaks across repos?"
 */

import { err, ok, validationError, type TraceMcpResult } from '../../errors.js';
import { SubprojectManager, type CrossRepoImpactResult } from '../../subproject/manager.js';
import type { TopologyStore } from '../../topology/topology-db.js';
import { getContractDrift, getCrossServiceImpact } from '../project/topology.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface FederationImpactResult {
  target: { endpoint?: string; service?: string; symbol_id?: string };
  /** Client repos that call this endpoint (from the subproject client-call scanner) */
  affected_clients: CrossRepoImpactResult[];
  /** Services affected via cross-service edges (event channels / HTTP calls) */
  affected_services: Array<{
    name: string;
    impact_type: string;
    confidence: number;
    details: string;
  }>;
  /** Spec-vs-implementation drift for the target service, when resolvable */
  contract_drift: Array<{
    type: 'missing_endpoint' | 'extra_endpoint' | 'unmatched_spec' | 'schema_breaking_change';
    detail: string;
  }>;
  /** Highest risk level across all three signals */
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  total_affected: number;
}

const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function maxRisk(a: string, b: string): 'low' | 'medium' | 'high' | 'critical' {
  return (RISK_ORDER[a] ?? 0) >= (RISK_ORDER[b] ?? 0)
    ? (a as 'low' | 'medium' | 'high' | 'critical')
    : (b as 'low' | 'medium' | 'high' | 'critical');
}

// ════════════════════════════════════════════════════════════════════════
// FEDERATION IMPACT
// ════════════════════════════════════════════════════════════════════════

/**
 * Aggregate cross-repo impact for a change described by an endpoint path,
 * a service name, or both. `symbol_id` is currently forwarded to the
 * subproject impact scanner as an informational field only — per-repo
 * symbol resolution already happens inside SubprojectManager.getImpact
 * when a per-repo index exists for the target endpoint's owning repo.
 */
export function getFederationImpact(
  topoStore: TopologyStore,
  store: { getAllRoutes(): Array<{ method: string; uri: string }> } | null,
  projectRoot: string,
  additionalRepos: string[],
  opts: { endpoint?: string; service?: string; symbol_id?: string; method?: string },
): TraceMcpResult<FederationImpactResult> {
  const { endpoint, service, method, symbol_id } = opts;

  if (!endpoint && !service) {
    return err(validationError('At least one of endpoint or service is required'));
  }

  // 1. Subproject client-call impact (which repos/files call this endpoint)
  let affectedClients: CrossRepoImpactResult[] = [];
  if (endpoint || service) {
    const manager = new SubprojectManager(topoStore);
    affectedClients = manager.getImpact({ endpoint, method, service });
  }

  // 2. Cross-service edge impact (event channels, service-to-service HTTP calls)
  let affectedServices: FederationImpactResult['affected_services'] = [];
  let serviceRisk: 'low' | 'medium' | 'high' = 'low';
  if (service) {
    const svcResult = getCrossServiceImpact(topoStore, projectRoot, additionalRepos, {
      service,
      endpoint,
    });
    if (svcResult.isOk()) {
      affectedServices = svcResult.value.affected_services;
      serviceRisk = svcResult.value.risk_level;
    }
    // A service that isn't registered in the topology yet is not a hard
    // error here — federation impact tolerates partial signal coverage.
  }

  // 3. Contract drift for the target service (spec vs implementation)
  let contractDrift: FederationImpactResult['contract_drift'] = [];
  if (service && store) {
    const driftResult = getContractDrift(topoStore, store, projectRoot, additionalRepos, {
      service,
    });
    if (driftResult.isOk()) {
      contractDrift = driftResult.value.drifts;
    }
  }

  // Aggregate risk: worst of (client-call risk levels, cross-service risk, drift presence)
  let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low';
  for (const c of affectedClients) {
    riskLevel = maxRisk(riskLevel, c.riskLevel);
  }
  riskLevel = maxRisk(riskLevel, serviceRisk);
  if (contractDrift.some((d) => d.type === 'schema_breaking_change')) {
    riskLevel = maxRisk(riskLevel, 'critical');
  } else if (contractDrift.length > 0) {
    riskLevel = maxRisk(riskLevel, 'medium');
  }

  const totalClients = affectedClients.reduce((sum, c) => sum + c.clients.length, 0);
  const totalAffected = totalClients + affectedServices.length + contractDrift.length;

  const parts: string[] = [];
  if (totalClients > 0)
    parts.push(`${totalClients} client call(s) across ${affectedClients.length} endpoint(s)`);
  if (affectedServices.length > 0) parts.push(`${affectedServices.length} dependent service(s)`);
  if (contractDrift.length > 0) parts.push(`${contractDrift.length} contract drift finding(s)`);
  const summary =
    parts.length > 0
      ? `Federation impact: ${parts.join(', ')}. Risk: ${riskLevel}.`
      : 'No cross-repo impact detected for this target.';

  return ok({
    target: { endpoint, service, symbol_id },
    affected_clients: affectedClients,
    affected_services: affectedServices,
    contract_drift: contractDrift,
    risk_level: riskLevel,
    summary,
    total_affected: totalAffected,
  });
}
