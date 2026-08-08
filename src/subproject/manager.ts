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

import fs from 'node:fs';
import path from 'node:path';
import { getDbPath } from '../global.js';
import { logger } from '../logger.js';
import {
  extractRoutesFromDb,
  parseContracts,
  type ParsedContract,
} from '../topology/contract-parser.js';
import { detectServices } from '../topology/service-detector.js';
import type { ClientCallRow, TopologyStore } from '../topology/topology-db.js';
import { scanClientCalls, scanEndpointLiterals } from './scanner.js';
import type { EndpointSchemaDiff } from './schema-diff.js';
import {
  detectBreakingChanges as _detectBreakingChanges,
  computeRiskLevel,
  resolveSymbolsAtLocation,
  upgradeRiskIfBreaking,
} from './subproject-helpers.js';
import type { SubprojectSearchResult } from './subproject-search.js';
import { subprojectSearch as _subprojectSearch } from './subproject-search.js';

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

export interface SubprojectAddResult {
  repo: string;
  name: string;
  services: number;
  contracts: number;
  endpoints: number;
  clientCalls: number;
  linkedCalls: number;
}

export interface SubprojectSyncResult {
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
// CONTRACT RESOLUTION HELPERS
// Pure functions extracted out of SubprojectManager#registerContracts (the
// module's most complex method) — neither depends on `this`, both only need
// serviceRoot/repoRoot, so they're plain functions rather than private methods.
// ════════════════════════════════════════════════════════════════════════

/** Resolve explicitly-configured contract paths (opts.contractPaths) against repoRoot. */
function resolveExplicitContracts(repoRoot?: string, explicitPaths?: string[]): ParsedContract[] {
  const resolved: ParsedContract[] = [];
  if (!explicitPaths || !repoRoot) return resolved;

  for (const cp of explicitPaths) {
    const absContract = path.resolve(repoRoot, cp);
    if (!fs.existsSync(absContract)) continue;
    const additional = parseContracts(path.dirname(absContract));
    resolved.push(...additional.filter((c) => path.resolve(repoRoot, c.specPath) === absContract));
  }
  return resolved;
}

/**
 * Fallback contract source: extract routes from the trace-mcp index DB when a
 * service ships no formal OpenAPI/GraphQL/Proto spec (Laravel, Next.js, Express, etc).
 * Tries the service's own DB first, then falls back to a parent monorepo DB
 * filtered to the service's subdirectory.
 */
function extractContractFromIndexDb(serviceRoot: string, repoRoot?: string): ParsedContract | null {
  const serviceDbPath = getDbPath(serviceRoot);
  const fromOwnDb = extractRoutesFromDb(serviceDbPath);
  if (fromOwnDb) return fromOwnDb;

  if (!repoRoot || repoRoot === serviceRoot) return null;

  const parentDbPath = getDbPath(repoRoot);
  const relPrefix = path.relative(repoRoot, serviceRoot);
  return extractRoutesFromDb(parentDbPath, relPrefix);
}

/**
 * Find which registered service a client call's file belongs to: exact
 * repo_root match first, then longest prefix match. Handles the case where a
 * parent folder is registered as a repo but services live in subdirectories
 * (e.g. repo_root="the/" but service.repo_root="the/fair-front/").
 * Extracted out of buildCrossServiceEdges() — pure given the pre-sorted
 * (longest-repo_root-first) services array, so the first hit is most specific.
 */
function findSourceService<T extends { repo_root: string }>(
  callFilePath: string,
  repoRoot: string,
  sortedServices: T[],
): T | undefined {
  const callPath = callFilePath.startsWith('/') ? callFilePath : `/${callFilePath}`;
  return sortedServices.find((s) => {
    if (s.repo_root === repoRoot) return true;
    const svcRoot = s.repo_root.endsWith('/') ? s.repo_root : `${s.repo_root}/`;
    return callPath.startsWith(svcRoot) || callFilePath.startsWith(svcRoot);
  });
}

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
  async add(
    repoRoot: string,
    projectRoot: string,
    opts?: {
      name?: string;
      contractPaths?: string[];
    },
  ): Promise<SubprojectAddResult> {
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

    const clientCalls = await this.scanAndLinkClientCalls(repoId, absRoot);

    // Build cross-service edges once at the end of the discovery run (was previously
    // rebuilt per-service inside scanAndLinkClientCalls).
    this.buildCrossServiceEdges();

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
  async autoDiscoverSubprojects(
    projectRoot: string,
    opts?: {
      contractPaths?: string[];
    },
  ): Promise<{ services: SubprojectAddResult[] }> {
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

    // Cache filesystem scans by repoRoot. When many services share the same root
    // (e.g. all discovered from a single docker-compose), avoid walking the tree N times.
    const clientCallScanCache = new Map<string, Awaited<ReturnType<typeof scanClientCalls>>>();
    const contractScanCache = new Map<string, ReturnType<typeof parseContracts>>();

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
      if (!contractScanCache.has(svc.repoRoot)) {
        contractScanCache.set(svc.repoRoot, parseContracts(svc.repoRoot));
      }
      this.registerContracts(
        serviceId,
        svc.repoRoot,
        absProjectRoot,
        opts?.contractPaths,
        contractScanCache.get(svc.repoRoot),
      );

      if (!clientCallScanCache.has(svc.repoRoot)) {
        clientCallScanCache.set(svc.repoRoot, await scanClientCalls(svc.repoRoot));
      }
      const clientCalls = await this.scanAndLinkClientCalls(
        repoId,
        svc.repoRoot,
        clientCallScanCache.get(svc.repoRoot),
        true, // skipLink — one linkClientCallsToEndpoints() call after all services are inserted
      );
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

    // One pass over all unlinked calls after ALL services are inserted — O(C×E) once
    // instead of O(N×C×E) when called once per service inside the loop above.
    this.topoStore.linkClientCallsToEndpoints();

    await this.scanCrossServiceEndpointLiterals(registered);

    // Build cross-service edges once for the whole discovery run. The per-service rebuild
    // was removed from scanAndLinkClientCalls, and the post-pass above only rebuilds when
    // it actually inserts new literal calls, so we always rebuild here to cover every path.
    this.buildCrossServiceEdges();

    return { services: results };
  }

  /**
   * Post-pass: for each repo, scan source files for URL literals that match endpoint paths
   * of OTHER services in the same project_group. Captures calls routed through factory
   * helpers / composables where the inline fetcher syntax would miss the URL
   * (e.g. Nuxt `useApiFetch(API.home())` with the path table in `useAppRoutes.ts`).
   */
  private async scanCrossServiceEndpointLiterals(
    registered: Array<{
      repoId: number;
      serviceId: number;
      repoRoot: string;
      projectGroup: string | null;
    }>,
  ): Promise<void> {
    if (registered.length < 2) return;

    const allEndpoints = this.topoStore.getAllEndpoints();
    let totalInserted = 0;

    // Group services by repoRoot so each unique directory is walked only once.
    // When many services share a root (e.g. all discovered from a single docker-compose),
    // the pre-fix code walked the same tree once per service — O(N) redundant I/O.
    const rootGroups = new Map<
      string,
      Array<{ repoId: number; serviceId: number; projectGroup: string | null }>
    >();
    for (const repo of registered) {
      const group = rootGroups.get(repo.repoRoot) ?? [];
      group.push({
        repoId: repo.repoId,
        serviceId: repo.serviceId,
        projectGroup: repo.projectGroup,
      });
      rootGroups.set(repo.repoRoot, group);
    }

    for (const [repoRoot, services] of rootGroups) {
      const rootServiceIds = new Set(services.map((s) => s.serviceId));
      const projectGroups = new Set(services.map((s) => s.projectGroup));

      // Cross-service endpoints: all endpoints belonging to services NOT in this
      // root group, that share a project_group with at least one service at this root.
      const crossServiceEndpoints = allEndpoints.filter((ep) => {
        if (rootServiceIds.has(ep.service_id)) return false;
        const epService = registered.find((r) => r.serviceId === ep.service_id);
        return epService != null && projectGroups.has(epService.projectGroup);
      });
      if (crossServiceEndpoints.length === 0) continue;

      const literalCalls = await scanEndpointLiterals(repoRoot, crossServiceEndpoints);
      if (literalCalls.length === 0) continue;

      // Attribute calls to the first repo in this root group. When services share
      // a root the per-service attribution is ambiguous; one canonical entry is correct.
      const repoId = services[0].repoId;
      this.topoStore.insertClientCalls(
        literalCalls.map((c) => ({
          sourceRepoId: repoId,
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

    // Re-link with the expanded client-call set. The cross-service edge rebuild is done
    // once by the autoDiscoverSubprojects() caller after this post-pass returns.
    this.topoStore.linkClientCallsToEndpoints();

    logger.info({ inserted: totalInserted }, 'Cross-service endpoint-literal scan completed');
  }

  /**
   * Remove a subproject.
   */
  remove(nameOrRoot: string): boolean {
    const repo = this.topoStore.getSubproject(nameOrRoot);
    if (!repo) return false;

    // Delegate to the transactional cascade-safe removal. Doing the deletes here
    // by hand previously failed with "FOREIGN KEY constraint failed": a service's
    // api_endpoints can be referenced by OTHER repos' client_calls
    // (matched_endpoint_id, no ON DELETE), so the service-delete cascade was
    // blocked. removeByRepoRoot() detaches those references first, in one tx.
    this.topoStore.removeByRepoRoot(repo.repo_root);
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
        // The subproject graph is about CROSS-repo edges. A call that resolves to
        // an endpoint in its own repo (e.g. a Nuxt page hitting its own server/api
        // route) is intra-app, not a cross-project dependency — skip it.
        if (call.target_repo_id === repo.id) continue;
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
  async sync(): Promise<SubprojectSyncResult> {
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

      const calls = await this.scanAndLinkClientCalls(repo.id, repo.repo_root, undefined, true);
      clientCallsScanned += calls.scanned;

      this.topoStore.updateSubprojectSyncTime(repo.id);
    }

    // Final relink across the full client-call set, then build cross-service edges once
    // for the whole run (was previously rebuilt per-repo inside scanAndLinkClientCalls).
    const newlyLinked = this.topoStore.linkClientCallsToEndpoints();
    this.buildCrossServiceEdges();

    return {
      repos: repos.length,
      servicesUpdated,
      contractsUpdated,
      endpointsUpdated,
      clientCallsScanned,
      newlyLinked,
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
    preScannedContracts?: ReturnType<typeof parseContracts>,
  ): void {
    const contracts = preScannedContracts ? [...preScannedContracts] : parseContracts(serviceRoot);
    contracts.push(...resolveExplicitContracts(repoRoot, explicitPaths));

    // Fallback: if no formal contracts found, try to extract routes from the
    // trace-mcp index DB (already indexed by the pipeline). This covers Laravel,
    // Next.js, Express, etc. that don't ship OpenAPI/GraphQL/Proto specs.
    if (contracts.length === 0) {
      const fromDb = extractContractFromIndexDb(serviceRoot, repoRoot);
      if (fromDb) contracts.push(fromDb);
    }

    this.persistContracts(serviceId, contracts);
  }

  /** Insert parsed contracts (+ their endpoints/events) for a service. */
  private persistContracts(serviceId: number, contracts: ParsedContract[]): void {
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
  private async scanAndLinkClientCalls(
    repoId: number,
    repoRoot: string,
    preScanned?: Awaited<ReturnType<typeof scanClientCalls>>,
    skipLink = false,
  ): Promise<{ scanned: number; linked: number }> {
    this.topoStore.deleteClientCallsByRepo(repoId);
    const clientCalls = preScanned ?? (await scanClientCalls(repoRoot));
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
    // When skipLink=true, the caller is responsible for a single linkClientCallsToEndpoints()
    // call after ALL services are inserted. Calling it once per service produces O(N²×E) work
    // because each pass re-processes unlinked calls accumulated from all previous services.
    if (skipLink) return { scanned: clientCalls.length, linked: 0 };
    const linked = this.topoStore.linkClientCallsToEndpoints();
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

  private collectEndpointClients(
    clientCalls: Array<ClientCallRow & { source_repo_name: string }>,
  ): CrossRepoImpactResult['clients'] {
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

    // Hoist the endpoint fetch out of the per-call loop: index endpoints by id ONCE
    // so the matched_endpoint_id lookup is a Map.get instead of a full JOIN + linear find.
    const endpointById = new Map<
      number,
      ReturnType<typeof this.topoStore.getAllEndpoints>[number]
    >();
    for (const ep of this.topoStore.getAllEndpoints()) {
      endpointById.set(ep.id, ep);
    }

    // Sort services longest-repo_root-first ONCE. The per-call source selection then uses
    // .find over this pre-sorted array, so the first matching candidate is the most specific
    // (longest repo_root), preserving the prior "sort by repo_root.length desc, pick [0]"
    // semantics. The exact-repo_root short-circuit is kept inside the predicate below.
    const sortedServices = [...services].sort((a, b) => b.repo_root.length - a.repo_root.length);

    for (const repo of repos) {
      const calls = this.topoStore.getClientCallsByRepo(repo.id);
      const linkedCalls = calls.filter((c) => c.matched_endpoint_id != null);

      for (const call of linkedCalls) {
        // Find target service from the matched endpoint
        const targetEndpoint = endpointById.get(call.matched_endpoint_id as number);
        if (!targetEndpoint) continue;

        const sourceService = findSourceService(call.file_path, repo.repo_root, sortedServices);
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
