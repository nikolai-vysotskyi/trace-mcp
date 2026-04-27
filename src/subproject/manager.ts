/**
 * Subproject Manager — orchestrates multi-repo graph linking.
 *
 * A subproject is any working repository that is part of your project's ecosystem:
 * microservices, frontends, backends, shared libraries, CLI tools, etc.
 *
 * Responsibilities:
 * - Add/remove repos as subprojects
 * - Parse contracts and register services/endpoints
 * - Scan repos for client calls and link to endpoints
 * - Cross-repo impact analysis at symbol level
 */

import path from 'node:path';
import fs from 'node:fs';
import type { TopologyStore, ClientCallRow } from '../topology/topology-db.js';
import { parseContracts, extractRoutesFromDb } from '../topology/contract-parser.js';
import { detectServices } from '../topology/service-detector.js';
import { scanClientCalls, scanEndpointLiterals } from './scanner.js';
import type { EndpointSchemaDiff } from './schema-diff.js';
import { getDbPath } from '../global.js';
import { logger } from '../logger.js';
import { subprojectSearch as _subprojectSearch } from './subproject-search.js';
import type { SubprojectSearchResult } from './subproject-search.js';
import {
  computeRiskLevel,
  upgradeRiskIfBreaking,
  detectBreakingChanges as _detectBreakingChanges,
  resolveSymbolsAtLocation,
} from './subproject-helpers.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

interface SubprojectAddResult {
  repo: string;
  name: string;
  services: number;
  contracts: number;
  endpoints: number;
  clientCalls: number;
  linkedCalls: number;
}

interface SubprojectSyncResult {
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

export interface SubprojectGraphResult {
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
export type { SubprojectSearchItem, SubprojectSearchResult } from './subproject-search.js';

// ════════════════════════════════════════════════════════════════════════
// MANAGER
// ════════════════════════════════════════════════════════════════════════

export class SubprojectManager {
  constructor(private topoStore: TopologyStore) {}

  /**
   * Add a repo as a subproject bound to a specific project.
   * Discovers services, parses contracts, scans for client calls, and links to known endpoints.
   *
   * @param repoRoot - path to the repo being added as a subproject
   * @param projectRoot - the project this subproject belongs to
   * @param opts - optional name, contract paths
   */
  add(
    repoRoot: string,
    projectRoot: string,
    opts?: {
      name?: string;
      contractPaths?: string[];
    },
  ): SubprojectAddResult {
    const absRoot = path.resolve(repoRoot);
    const absProjectRoot = path.resolve(projectRoot);
    if (!fs.existsSync(absRoot)) {
      throw new Error(`Repository path does not exist: ${absRoot}`);
    }

    const repoName = opts?.name ?? path.basename(absRoot);
    const dbPath = getDbPath(absRoot);

    const repoId = this.topoStore.upsertSubproject({
      name: repoName,
      repoRoot: absRoot,
      projectRoot: absProjectRoot,
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
      this.topoStore.deleteContractsByService(serviceId);
      this.registerContracts(serviceId, svc.repoRoot, absRoot, opts?.contractPaths);
    }

    const clientCalls = this.scanAndLinkClientCalls(repoId, absRoot);

    this.topoStore.updateSubprojectSyncTime(repoId);

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
   * Auto-discover subprojects: detect services within the project root
   * and register each as a subproject bound to this project.
   * Unlike add(), this doesn't add the project itself — it discovers
   * sub-services (from docker-compose, workspace structure, or root markers).
   */
  autoDiscoverSubprojects(
    projectRoot: string,
    opts?: {
      contractPaths?: string[];
    },
  ): { services: SubprojectAddResult[] } {
    const absProjectRoot = path.resolve(projectRoot);
    if (!fs.existsSync(absProjectRoot)) {
      throw new Error(`Project path does not exist: ${absProjectRoot}`);
    }

    const detected = detectServices([absProjectRoot]);
    const results: SubprojectAddResult[] = [];
    // Track registered repos for the post-pass that scans cross-service endpoint literals.
    // We defer that scan to the end so every service's endpoints are already in the DB.
    const registered: Array<{
      repoId: number;
      serviceId: number;
      repoRoot: string;
      projectGroup: string | null;
    }> = [];

    for (const svc of detected) {
      const repoName = svc.name;
      const dbPath = getDbPath(svc.repoRoot);

      const repoId = this.topoStore.upsertSubproject({
        name: repoName,
        repoRoot: svc.repoRoot,
        projectRoot: absProjectRoot,
        dbPath: fs.existsSync(dbPath) ? dbPath : undefined,
        contractPaths: opts?.contractPaths,
      });

      const serviceId = this.topoStore.upsertService({
        name: svc.name,
        repoRoot: svc.repoRoot,
        dbPath,
        serviceType: svc.serviceType,
        detectionSource: svc.detectionSource,
        projectGroup: svc.projectGroup,
        metadata: svc.metadata,
      });
      this.topoStore.deleteContractsByService(serviceId);
      this.registerContracts(serviceId, svc.repoRoot, absProjectRoot, opts?.contractPaths);

      const clientCalls = this.scanAndLinkClientCalls(repoId, svc.repoRoot);
      this.topoStore.updateSubprojectSyncTime(repoId);
      registered.push({
        repoId,
        serviceId,
        repoRoot: svc.repoRoot,
        projectGroup: svc.projectGroup ?? null,
      });

      const stats = this.topoStore.getTopologyStats();
      results.push({
        repo: svc.repoRoot,
        name: repoName,
        services: 1,
        contracts: stats.contracts,
        endpoints: stats.endpoints,
        clientCalls: clientCalls.scanned,
        linkedCalls: clientCalls.linked,
      });
    }

    this.scanCrossServiceEndpointLiterals(registered);

    return { services: results };
  }

  /**
   * Post-pass: for each repo, scan source files for URL literals that match endpoint paths
   * of OTHER services in the same project_group. Captures calls routed through factory
   * helpers / composables where the inline fetcher syntax would miss the URL
   * (e.g. Nuxt `useApiFetch(API.home())` with the path table in `useAppRoutes.ts`).
   */
  private scanCrossServiceEndpointLiterals(
    registered: Array<{
      repoId: number;
      serviceId: number;
      repoRoot: string;
      projectGroup: string | null;
    }>,
  ): void {
    if (registered.length < 2) return;

    const allEndpoints = this.topoStore.getAllEndpoints();
    let totalInserted = 0;

    for (const repo of registered) {
      const crossServiceEndpoints = allEndpoints.filter((ep) => {
        if (ep.service_id === repo.serviceId) return false; // exclude own service
        const epService = registered.find((r) => r.serviceId === ep.service_id);
        // Only match against same-group services we registered in this run
        return epService != null && epService.projectGroup === repo.projectGroup;
      });
      if (crossServiceEndpoints.length === 0) continue;

      const literalCalls = scanEndpointLiterals(repo.repoRoot, crossServiceEndpoints);
      if (literalCalls.length === 0) continue;

      this.topoStore.insertClientCalls(
        literalCalls.map((c) => ({
          sourceRepoId: repo.repoId,
          filePath: c.filePath,
          line: c.line,
          callType: c.callType,
          method: c.method == null ? undefined : c.method,
          urlPattern: c.urlPattern,
          confidence: c.confidence,
        })),
      );
      totalInserted += literalCalls.length;
    }

    if (totalInserted === 0) return;

    // Re-link with the expanded client-call set and rebuild cross-service edges.
    this.topoStore.linkClientCallsToEndpoints();
    this.buildCrossServiceEdges();

    logger.info({ inserted: totalInserted }, 'Cross-service endpoint-literal scan completed');
  }

  /**
   * Remove a subproject.
   */
  remove(nameOrRoot: string): boolean {
    const repo = this.topoStore.getSubproject(nameOrRoot);
    if (!repo) return false;

    // Remove client calls
    this.topoStore.deleteClientCallsByRepo(repo.id);

    // Remove associated services
    const services = this.topoStore.getAllServices().filter((s) => s.repo_root === repo.repo_root);
    for (const svc of services) {
      this.topoStore.deleteService(svc.id);
    }

    // Remove repo
    this.topoStore.deleteSubproject(repo.id);
    return true;
  }

  /**
   * List subprojects with stats, optionally filtered by project.
   */
  list(projectRoot?: string): SubprojectGraphResult {
    const repos = projectRoot
      ? this.topoStore.getSubprojectsByProject(projectRoot)
      : this.topoStore.getAllSubprojects();
    const allServices = this.topoStore.getAllServices();
    const allEndpoints = this.topoStore.getAllEndpoints();
    const subStats = this.topoStore.getSubprojectStats();

    const repoResults: SubprojectGraphResult['repos'] = repos.map((repo) => {
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
    const edgeMap = new Map<
      string,
      {
        source: string;
        target: string;
        callCount: number;
        linkedCount: number;
        callTypes: Set<string>;
      }
    >();

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
        repos: subStats.repos,
        totalEndpoints: allEndpoints.length,
        totalClientCalls: subStats.clientCalls,
        linkedCallsPercent:
          subStats.clientCalls > 0
            ? Math.round((subStats.linkedCalls / subStats.clientCalls) * 100)
            : 0,
      },
    };
  }

  /**
   * Re-sync all subprojects: re-scan contracts and client calls,
   * re-link everything.
   */
  sync(): SubprojectSyncResult {
    const repos = this.topoStore.getAllSubprojects();
    let servicesUpdated = 0;
    let contractsUpdated = 0;
    let endpointsUpdated = 0;
    let clientCallsScanned = 0;

    for (const repo of repos) {
      if (!fs.existsSync(repo.repo_root)) {
        logger.warn(
          { repo: repo.name, root: repo.repo_root },
          'Subproject repo no longer exists, skipping',
        );
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
        this.registerContracts(serviceId, svc.repoRoot, repo.project_root);
      }

      const calls = this.scanAndLinkClientCalls(repo.id, repo.repo_root);
      clientCallsScanned += calls.scanned;

      this.topoStore.updateSubprojectSyncTime(repo.id);
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
   * find all client code across subprojects that would break.
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
      const repo = svc ? this.topoStore.getSubproject(svc.repo_root) : undefined;
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
          contracts.push(
            ...additional.filter((c) => path.resolve(repoRoot, c.specPath) === absContract),
          );
        }
      }
    }

    // Fallback: if no formal contracts found, try to extract routes from the
    // trace-mcp index DB (already indexed by the pipeline). This covers Laravel,
    // Next.js, Express, etc. that don't ship OpenAPI/GraphQL/Proto specs.
    if (contracts.length === 0) {
      // 1. Try the service's own DB (if it was indexed standalone)
      const serviceDbPath = getDbPath(serviceRoot);
      let fromDb = extractRoutesFromDb(serviceDbPath);

      // 2. If service was indexed as part of a parent monorepo (common case when
      //    the user runs `trace-mcp index the/`), the DB lives at the parent root.
      //    Filter routes to this service's subdirectory using pathPrefix.
      //    The prefix must be relative to the parent root (file paths in DB are relative).
      if (!fromDb && repoRoot && repoRoot !== serviceRoot) {
        const parentDbPath = getDbPath(repoRoot);
        const relPrefix = path.relative(repoRoot, serviceRoot);
        fromDb = extractRoutesFromDb(parentDbPath, relPrefix);
      }

      if (fromDb) contracts.push(fromDb);
    }

    for (const contract of contracts) {
      const contractId = this.topoStore.insertContract(serviceId, {
        contractType: contract.type,
        specPath: contract.specPath,
        version: contract.version,
        parsedSpec: JSON.stringify({ endpoints: contract.endpoints, events: contract.events }),
      });

      this.topoStore.insertEndpoints(
        contractId,
        serviceId,
        contract.endpoints.map((e) => ({
          method: e.method ?? undefined,
          path: e.path,
          operationId: e.operationId,
          requestSchema: e.requestSchema ? JSON.stringify(e.requestSchema) : undefined,
          responseSchema: e.responseSchema ? JSON.stringify(e.responseSchema) : undefined,
        })),
      );

      if (contract.events.length > 0) {
        this.topoStore.insertEventChannels(
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
  private scanAndLinkClientCalls(
    repoId: number,
    repoRoot: string,
  ): { scanned: number; linked: number } {
    this.topoStore.deleteClientCallsByRepo(repoId);
    const clientCalls = scanClientCalls(repoRoot);
    if (clientCalls.length > 0) {
      this.topoStore.insertClientCalls(
        clientCalls.map((c) => ({
          sourceRepoId: repoId,
          filePath: c.filePath,
          line: c.line,
          callType: c.callType,
          method: c.method == null ? undefined : c.method,
          urlPattern: c.urlPattern,
          confidence: c.confidence,
        })),
      );
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
      endpoints = endpoints.filter(
        (ep) => ep.service_name.toLowerCase() === opts.service!.toLowerCase(),
      );
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
      const repo = this.topoStore.getSubproject(repoName);
      for (const call of calls) {
        const symbols =
          repo?.db_path && fs.existsSync(repo.db_path)
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

  private detectBreakingChanges(ep: {
    id: number;
    method: string | null;
    path: string;
    service_id: number;
  }): EndpointSchemaDiff[] | undefined {
    return _detectBreakingChanges(this.topoStore, ep);
  }

  /** Search across all subprojects — delegates to subproject-search module. */
  subprojectSearch(
    query: string,
    filters?: { kind?: string; language?: string; filePattern?: string },
    limit = 20,
    excludeRoot?: string,
  ): SubprojectSearchResult {
    return _subprojectSearch(this.topoStore, query, filters, limit, excludeRoot);
  }

  /**
   * Build cross-service edges from linked client calls.
   */
  private buildCrossServiceEdges(): void {
    const repos = this.topoStore.getAllSubprojects();
    const services = this.topoStore.getAllServices();

    for (const repo of repos) {
      const calls = this.topoStore.getClientCallsByRepo(repo.id);
      const linkedCalls = calls.filter((c) => c.matched_endpoint_id != null);

      for (const call of linkedCalls) {
        // Find target service from the matched endpoint
        const targetEndpoint = this.topoStore
          .getAllEndpoints()
          .find((e) => e.id === call.matched_endpoint_id);
        if (!targetEndpoint) continue;

        // Find source service: exact match first, then longest prefix match (handles
        // the case where a parent folder is registered as a repo but services live
        // in subdirectories, e.g. repo_root="the/" but service.repo_root="the/fair-front/").
        const _repoRoot = repo.repo_root.endsWith('/') ? repo.repo_root : `${repo.repo_root}/`;
        const callPath = call.file_path.startsWith('/') ? call.file_path : `/${call.file_path}`;
        const candidates = services.filter((s) => {
          if (s.repo_root === repo.repo_root) return true;
          const svcRoot = s.repo_root.endsWith('/') ? s.repo_root : `${s.repo_root}/`;
          return callPath.startsWith(svcRoot) || call.file_path.startsWith(svcRoot);
        });
        // Pick most specific (longest repo_root wins)
        const sourceService = candidates.sort((a, b) => b.repo_root.length - a.repo_root.length)[0];
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
