/**
 * Federation Manager — orchestrates multi-repo graph federation.
 *
 * Responsibilities:
 * - Add/remove repos to the federation
 * - Parse contracts and register services/endpoints
 * - Scan repos for client calls and link to endpoints
 * - Cross-repo impact analysis at symbol level
 */

import path from 'node:path';
import fs from 'node:fs';
import { TopologyStore, type FederatedRepoRow, type ClientCallRow } from '../topology/topology-db.js';
import { parseContracts } from '../topology/contract-parser.js';
import { detectServices } from '../topology/service-detector.js';
import { scanClientCalls } from './scanner.js';
import { diffEndpoints, type EndpointSchemaDiff } from './schema-diff.js';
import { getDbPath } from '../global.js';
import { Store } from '../db/store.js';
import { logger } from '../logger.js';
import { federatedSearch as _federatedSearch } from './federated-search.js';
import type { FederatedSearchResult } from './federated-search.js';
import {
  computeRiskLevel,
  upgradeRiskIfBreaking,
  detectBreakingChanges as _detectBreakingChanges,
  resolveSymbolsAtLocation,
} from './federation-helpers.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface FederationAddResult {
  repo: string;
  name: string;
  services: number;
  contracts: number;
  endpoints: number;
  clientCalls: number;
  linkedCalls: number;
}

interface FederationSyncResult {
  repos: number;
  servicesUpdated: number;
  contractsUpdated: number;
  endpointsUpdated: number;
  clientCallsScanned: number;
  newlyLinked: number;
  crossRepoEdges: number;
}

export interface CrossRepoImpactResult {
  endpoint: {
    method: string | null;
    path: string;
    service: string;
    repo: string;
  };
  clients: Array<{
    repo: string;
    filePath: string;
    line: number | null;
    callType: string;
    confidence: number;
    /** Symbols in the client repo that contain this call (if per-repo DB available) */
    symbols: Array<{ symbolId: string; name: string; kind: string; fqn: string | null }>;
  }>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  /** Schema-level breaking changes detected for this endpoint (if contract snapshots exist) */
  breakingChanges?: import('./schema-diff.js').EndpointSchemaDiff[];
}

export interface FederationGraphResult {
  repos: Array<{
    name: string;
    repoRoot: string;
    services: number;
    endpoints: number;
    clientCalls: number;
    lastSynced: string | null;
  }>;
  edges: Array<{
    source: string;
    target: string;
    callCount: number;
    linkedCount: number;
    callTypes: string[];
  }>;
  stats: {
    repos: number;
    totalEndpoints: number;
    totalClientCalls: number;
    linkedCallsPercent: number;
  };
}

// Re-export so existing callers importing from manager.ts still work
export type { FederatedSearchItem, FederatedSearchResult } from './federated-search.js';

// ════════════════════════════════════════════════════════════════════════
// MANAGER
// ════════════════════════════════════════════════════════════════════════

export class FederationManager {
  constructor(private topoStore: TopologyStore) {}

  /**
   * Add a repo to the federation. Discovers services, parses contracts,
   * scans for client calls, and links them to known endpoints.
   */
  add(repoRoot: string, opts?: {
    name?: string;
    contractPaths?: string[];
  }): FederationAddResult {
    const absRoot = path.resolve(repoRoot);
    if (!fs.existsSync(absRoot)) {
      throw new Error(`Repository path does not exist: ${absRoot}`);
    }

    const repoName = opts?.name ?? path.basename(absRoot);
    const dbPath = getDbPath(absRoot);

    const repoId = this.topoStore.upsertFederatedRepo({
      name: repoName,
      repoRoot: absRoot,
      dbPath: fs.existsSync(dbPath) ? dbPath : undefined,
      contractPaths: opts?.contractPaths,
    });

    const detected = detectServices([absRoot]);
    for (const svc of detected) {
      const serviceId = this.topoStore.upsertService({
        name: svc.name,
        repoRoot: svc.repoRoot,
        dbPath: getDbPath(svc.repoRoot),
        serviceType: svc.serviceType,
        detectionSource: svc.detectionSource,
        projectGroup: svc.projectGroup,
        metadata: svc.metadata,
      });
      this.registerContracts(serviceId, svc.repoRoot, absRoot, opts?.contractPaths);
    }

    const clientCalls = this.scanAndLinkClientCalls(repoId, absRoot);

    this.topoStore.updateFederatedRepoSyncTime(repoId);

    const stats = this.topoStore.getTopologyStats();
    return {
      repo: absRoot,
      name: repoName,
      services: detected.length,
      contracts: stats.contracts,
      endpoints: stats.endpoints,
      clientCalls: clientCalls.scanned,
      linkedCalls: clientCalls.linked,
    };
  }

  /**
   * Remove a repo from the federation.
   */
  remove(nameOrRoot: string): boolean {
    const repo = this.topoStore.getFederatedRepo(nameOrRoot);
    if (!repo) return false;

    // Remove client calls
    this.topoStore.deleteClientCallsByRepo(repo.id);

    // Remove associated services
    const services = this.topoStore.getAllServices().filter(
      (s) => s.repo_root === repo.repo_root,
    );
    for (const svc of services) {
      this.topoStore.deleteService(svc.id);
    }

    // Remove repo
    this.topoStore.deleteFederatedRepo(repo.id);
    return true;
  }

  /**
   * List all federated repos with stats.
   */
  list(): FederationGraphResult {
    const repos = this.topoStore.getAllFederatedRepos();
    const allServices = this.topoStore.getAllServices();
    const allEndpoints = this.topoStore.getAllEndpoints();
    const fedStats = this.topoStore.getFederationStats();

    const repoResults: FederationGraphResult['repos'] = repos.map((repo) => {
      const services = allServices.filter((s) => s.repo_root === repo.repo_root);
      const serviceIds = new Set(services.map((s) => s.id));
      const endpoints = allEndpoints.filter((e) => serviceIds.has(e.service_id));
      const clientCalls = this.topoStore.getClientCallsByRepo(repo.id);

      return {
        name: repo.name,
        repoRoot: repo.repo_root,
        services: services.length,
        endpoints: endpoints.length,
        clientCalls: clientCalls.length,
        lastSynced: repo.last_synced,
      };
    });

    // Build edges: aggregate client calls by source_repo → target_repo
    const edgeMap = new Map<string, {
      source: string;
      target: string;
      callCount: number;
      linkedCount: number;
      callTypes: Set<string>;
    }>();

    for (const repo of repos) {
      const calls = this.topoStore.getClientCallsByRepo(repo.id);
      for (const call of calls) {
        if (!call.target_repo_id) continue;
        const targetRepo = repos.find((r) => r.id === call.target_repo_id);
        if (!targetRepo) continue;

        const key = `${repo.name}→${targetRepo.name}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, {
            source: repo.name,
            target: targetRepo.name,
            callCount: 0,
            linkedCount: 0,
            callTypes: new Set(),
          });
        }
        const edge = edgeMap.get(key)!;
        edge.callCount++;
        if (call.matched_endpoint_id) edge.linkedCount++;
        edge.callTypes.add(call.call_type);
      }
    }

    return {
      repos: repoResults,
      edges: [...edgeMap.values()].map((e) => ({
        ...e,
        callTypes: [...e.callTypes],
      })),
      stats: {
        repos: fedStats.repos,
        totalEndpoints: allEndpoints.length,
        totalClientCalls: fedStats.clientCalls,
        linkedCallsPercent: fedStats.clientCalls > 0
          ? Math.round((fedStats.linkedCalls / fedStats.clientCalls) * 100)
          : 0,
      },
    };
  }

  /**
   * Re-sync all federated repos: re-scan contracts and client calls,
   * re-link everything.
   */
  sync(): FederationSyncResult {
    const repos = this.topoStore.getAllFederatedRepos();
    let servicesUpdated = 0;
    let contractsUpdated = 0;
    let endpointsUpdated = 0;
    let clientCallsScanned = 0;

    for (const repo of repos) {
      if (!fs.existsSync(repo.repo_root)) {
        logger.warn({ repo: repo.name, root: repo.repo_root }, 'Federated repo no longer exists, skipping');
        continue;
      }

      const detected = detectServices([repo.repo_root]);
      servicesUpdated += detected.length;

      for (const svc of detected) {
        const serviceId = this.topoStore.upsertService({
          name: svc.name,
          repoRoot: svc.repoRoot,
          dbPath: getDbPath(svc.repoRoot),
          serviceType: svc.serviceType,
          detectionSource: svc.detectionSource,
          metadata: svc.metadata,
        });

        this.snapshotContracts(serviceId);
        this.topoStore.deleteContractsByService(serviceId);

        const contracts = parseContracts(svc.repoRoot);
        contractsUpdated += contracts.length;
        for (const contract of contracts) {
          endpointsUpdated += contract.endpoints.length;
        }
        this.registerContracts(serviceId, svc.repoRoot);
      }

      const calls = this.scanAndLinkClientCalls(repo.id, repo.repo_root);
      clientCallsScanned += calls.scanned;

      this.topoStore.updateFederatedRepoSyncTime(repo.id);
    }

    return {
      repos: repos.length,
      servicesUpdated,
      contractsUpdated,
      endpointsUpdated,
      clientCallsScanned,
      newlyLinked: this.topoStore.linkClientCallsToEndpoints(),
      crossRepoEdges: this.topoStore.getTopologyStats().crossEdges,
    };
  }

  /**
   * Cross-repo impact analysis: given an endpoint (or path pattern),
   * find all client code across federated repos that would break.
   * If per-repo DBs exist, resolves down to symbol level.
   */
  getImpact(opts: {
    endpoint?: string;
    method?: string;
    service?: string;
  }): CrossRepoImpactResult[] {
    const matchingEndpoints = this.filterEndpoints(opts);
    const results: CrossRepoImpactResult[] = [];

    for (const ep of matchingEndpoints) {
      const clientCalls = this.topoStore.getClientCallsByEndpoint(ep.id);
      if (clientCalls.length === 0) continue;

      const clients = this.collectEndpointClients(clientCalls);
      const uniqueRepos = new Set(clients.map((c) => c.repo));
      const baseRisk = computeRiskLevel(uniqueRepos.size, clients.length);

      const svc = this.topoStore.getAllServices().find((s) => s.id === ep.service_id);
      const repo = svc ? this.topoStore.getFederatedRepo(svc.repo_root) : undefined;
      const breakingChanges = this.detectBreakingChanges(ep);
      const riskLevel = upgradeRiskIfBreaking(baseRisk, breakingChanges);

      results.push({
        endpoint: {
          method: ep.method,
          path: ep.path,
          service: ep.service_name,
          repo: repo?.name ?? svc?.repo_root ?? 'unknown',
        },
        clients,
        riskLevel,
        summary: `${ep.method ?? '*'} ${ep.path} is called by ${clients.length} client(s) in ${uniqueRepos.size} repo(s)${breakingChanges ? ' ⚠ BREAKING SCHEMA CHANGES' : ''}`,
        breakingChanges,
      });
    }

    return results;
  }

  /** Register contracts for a service, including explicitly provided paths. */
  private registerContracts(
    serviceId: number,
    serviceRoot: string,
    repoRoot?: string,
    explicitPaths?: string[],
  ): void {
    const contracts = parseContracts(serviceRoot);

    if (explicitPaths && repoRoot) {
      for (const cp of explicitPaths) {
        const absContract = path.resolve(repoRoot, cp);
        if (fs.existsSync(absContract)) {
          const additional = parseContracts(path.dirname(absContract));
          contracts.push(...additional.filter(
            (c) => path.resolve(repoRoot, c.specPath) === absContract,
          ));
        }
      }
    }

    for (const contract of contracts) {
      const contractId = this.topoStore.insertContract(serviceId, {
        contractType: contract.type,
        specPath: contract.specPath,
        version: contract.version,
        parsedSpec: JSON.stringify({ endpoints: contract.endpoints, events: contract.events }),
      });

      this.topoStore.insertEndpoints(contractId, serviceId,
        contract.endpoints.map((e) => ({
          method: e.method ?? undefined,
          path: e.path,
          operationId: e.operationId,
          requestSchema: e.requestSchema ? JSON.stringify(e.requestSchema) : undefined,
          responseSchema: e.responseSchema ? JSON.stringify(e.responseSchema) : undefined,
        })),
      );

      if (contract.events.length > 0) {
        this.topoStore.insertEventChannels(contractId, serviceId,
          contract.events.map((e) => ({
            channelName: e.channelName,
            direction: e.direction,
          })),
        );
      }
    }
  }

  /** Snapshot existing contracts before replacing them (for drift detection). */
  private snapshotContracts(serviceId: number): void {
    const existing = this.topoStore.getContractsByService(serviceId);
    for (const ec of existing) {
      this.topoStore.insertContractSnapshot(ec.id, serviceId, {
        version: ec.version,
        specPath: ec.spec_path,
        contentHash: ec.content_hash ?? '',
        endpointsJson: ec.parsed_spec,
        eventsJson: '[]',
      });
    }
  }

  /** Scan repo for client calls, insert them, link to endpoints, and build edges. */
  private scanAndLinkClientCalls(repoId: number, repoRoot: string): { scanned: number; linked: number } {
    this.topoStore.deleteClientCallsByRepo(repoId);
    const clientCalls = scanClientCalls(repoRoot);
    if (clientCalls.length > 0) {
      this.topoStore.insertClientCalls(clientCalls.map((c) => ({
        sourceRepoId: repoId,
        filePath: c.filePath,
        line: c.line,
        callType: c.callType,
        method: c.method,
        urlPattern: c.urlPattern,
        confidence: c.confidence,
      })));
    }
    const linked = this.topoStore.linkClientCallsToEndpoints();
    this.buildCrossServiceEdges();
    return { scanned: clientCalls.length, linked };
  }

  private filterEndpoints(opts: { endpoint?: string; method?: string; service?: string }) {
    let endpoints = this.topoStore.getAllEndpoints();
    if (opts.endpoint) {
      const normalized = opts.endpoint.toLowerCase();
      endpoints = endpoints.filter((ep) => ep.path.toLowerCase().includes(normalized));
    }
    if (opts.method) {
      endpoints = endpoints.filter((ep) => ep.method?.toUpperCase() === opts.method!.toUpperCase());
    }
    if (opts.service) {
      endpoints = endpoints.filter((ep) => ep.service_name.toLowerCase() === opts.service!.toLowerCase());
    }
    return endpoints;
  }

  private collectEndpointClients(clientCalls: ClientCallRow[]): CrossRepoImpactResult['clients'] {
    const byRepo = new Map<string, ClientCallRow[]>();
    for (const call of clientCalls) {
      const repo = call.source_repo_name;
      if (!byRepo.has(repo)) byRepo.set(repo, []);
      byRepo.get(repo)!.push(call);
    }

    const clients: CrossRepoImpactResult['clients'] = [];
    for (const [repoName, calls] of byRepo) {
      const repo = this.topoStore.getFederatedRepo(repoName);
      for (const call of calls) {
        const symbols = repo?.db_path && fs.existsSync(repo.db_path)
          ? resolveSymbolsAtLocation(repo.db_path, call.file_path, call.line)
          : [];
        clients.push({
          repo: repoName,
          filePath: call.file_path,
          line: call.line,
          callType: call.call_type,
          confidence: call.confidence,
          symbols,
        });
      }
    }
    return clients;
  }

  private detectBreakingChanges(ep: { id: number; method: string | null; path: string; service_id: number }): EndpointSchemaDiff[] | undefined {
    return _detectBreakingChanges(this.topoStore, ep);
  }

  /** Search across all federated repos — delegates to federated-search module. */
  federatedSearch(
    query: string,
    filters?: { kind?: string; language?: string; filePattern?: string },
    limit = 20,
  ): FederatedSearchResult {
    return _federatedSearch(this.topoStore, query, filters, limit);
  }

  /**
   * Build cross-service edges from linked client calls.
   */
  private buildCrossServiceEdges(): void {
    const repos = this.topoStore.getAllFederatedRepos();
    const services = this.topoStore.getAllServices();

    for (const repo of repos) {
      const calls = this.topoStore.getClientCallsByRepo(repo.id);
      const linkedCalls = calls.filter((c) => c.matched_endpoint_id != null);

      for (const call of linkedCalls) {
        // Find target service from the matched endpoint
        const targetEndpoint = this.topoStore.getAllEndpoints().find((e) => e.id === call.matched_endpoint_id);
        if (!targetEndpoint) continue;

        // Find source service
        const sourceService = services.find((s) => s.repo_root === repo.repo_root);
        if (!sourceService || sourceService.id === targetEndpoint.service_id) continue;

        this.topoStore.insertCrossServiceEdge({
          sourceServiceId: sourceService.id,
          targetServiceId: targetEndpoint.service_id,
          edgeType: 'api_call',
          sourceRef: `${call.file_path}:${call.line}`,
          targetRef: `${targetEndpoint.method ?? '*'} ${targetEndpoint.path}`,
          confidence: call.confidence,
        });
      }
    }
  }
}

