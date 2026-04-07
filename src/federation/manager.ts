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
import Database from 'better-sqlite3';
import { TopologyStore, type FederatedRepoRow, type ClientCallRow } from '../topology/topology-db.js';
import { parseContracts } from '../topology/contract-parser.js';
import { detectServices } from '../topology/service-detector.js';
import { scanClientCalls } from './scanner.js';
import { diffEndpoints, type EndpointSchemaDiff } from './schema-diff.js';
import { searchFts } from '../db/fts.js';
import { getDbPath } from '../global.js';
import { Store } from '../db/store.js';
import { logger } from '../logger.js';

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

export interface FederatedSearchItem {
  repo: string;
  symbol_id: string;
  name: string;
  kind: string;
  fqn: string | null;
  signature: string | null;
  file: string;
  line: number | null;
  score: number;
}

export interface FederatedSearchResult {
  items: FederatedSearchItem[];
  total: number;
  repos_searched: number;
}

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

    // 1. Register federated repo
    const repoId = this.topoStore.upsertFederatedRepo({
      name: repoName,
      repoRoot: absRoot,
      dbPath: fs.existsSync(dbPath) ? dbPath : undefined,
      contractPaths: opts?.contractPaths,
    });

    // 2. Detect services and register
    const detected = detectServices([absRoot]);
    for (const svc of detected) {
      const serviceId = this.topoStore.upsertService({
        name: svc.name,
        repoRoot: svc.repoRoot,
        dbPath: getDbPath(svc.repoRoot),
        serviceType: svc.serviceType,
        detectionSource: svc.detectionSource,
        metadata: svc.metadata,
      });

      // 3. Parse contracts (auto-discovered + explicit)
      const contracts = parseContracts(svc.repoRoot);

      // Also parse explicitly provided contract files
      if (opts?.contractPaths) {
        for (const cp of opts.contractPaths) {
          const absContract = path.resolve(absRoot, cp);
          if (fs.existsSync(absContract)) {
            const additionalContracts = parseContracts(path.dirname(absContract));
            contracts.push(...additionalContracts.filter(
              (c) => path.resolve(absRoot, c.specPath) === absContract,
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

    // 4. Scan for client calls
    this.topoStore.deleteClientCallsByRepo(repoId);
    const clientCalls = scanClientCalls(absRoot);
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

    // 5. Link client calls to known endpoints
    const linkedCount = this.topoStore.linkClientCallsToEndpoints();

    // 6. Create cross-service edges from linked calls
    this.buildCrossServiceEdges();

    this.topoStore.updateFederatedRepoSyncTime(repoId);

    const stats = this.topoStore.getTopologyStats();
    return {
      repo: absRoot,
      name: repoName,
      services: detected.length,
      contracts: stats.contracts,
      endpoints: stats.endpoints,
      clientCalls: clientCalls.length,
      linkedCalls: linkedCount,
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

      // Re-detect services
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

        // Snapshot existing contracts before replacing
        const existingContracts = this.topoStore.getContractsByService(serviceId);
        for (const ec of existingContracts) {
          this.topoStore.insertContractSnapshot(ec.id, serviceId, {
            version: ec.version,
            specPath: ec.spec_path,
            contentHash: ec.content_hash ?? '',
            endpointsJson: ec.parsed_spec,
            eventsJson: '[]',
          });
        }

        // Clean old contracts for this service and re-parse
        this.topoStore.deleteContractsByService(serviceId);

        const contracts = parseContracts(svc.repoRoot);
        contractsUpdated += contracts.length;

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
          endpointsUpdated += contract.endpoints.length;

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

      // Re-scan client calls
      this.topoStore.deleteClientCallsByRepo(repo.id);
      const calls = scanClientCalls(repo.repo_root);
      clientCallsScanned += calls.length;

      if (calls.length > 0) {
        this.topoStore.insertClientCalls(calls.map((c) => ({
          sourceRepoId: repo.id,
          filePath: c.filePath,
          line: c.line,
          callType: c.callType,
          method: c.method,
          urlPattern: c.urlPattern,
          confidence: c.confidence,
        })));
      }

      this.topoStore.updateFederatedRepoSyncTime(repo.id);
    }

    // Link and build edges
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
   * find all client code across federated repos that would break.
   * If per-repo DBs exist, resolves down to symbol level.
   */
  getImpact(opts: {
    endpoint?: string;
    method?: string;
    service?: string;
  }): CrossRepoImpactResult[] {
    const results: CrossRepoImpactResult[] = [];
    const allEndpoints = this.topoStore.getAllEndpoints();

    // Find matching endpoints
    let matchingEndpoints = allEndpoints;
    if (opts.endpoint) {
      const normalized = opts.endpoint.toLowerCase();
      matchingEndpoints = allEndpoints.filter((ep) =>
        ep.path.toLowerCase().includes(normalized),
      );
    }
    if (opts.method) {
      matchingEndpoints = matchingEndpoints.filter((ep) =>
        ep.method?.toUpperCase() === opts.method!.toUpperCase(),
      );
    }
    if (opts.service) {
      matchingEndpoints = matchingEndpoints.filter((ep) =>
        ep.service_name.toLowerCase() === opts.service!.toLowerCase(),
      );
    }

    for (const ep of matchingEndpoints) {
      const clientCalls = this.topoStore.getClientCallsByEndpoint(ep.id);
      if (clientCalls.length === 0) continue;

      // Group by repo
      const byRepo = new Map<string, typeof clientCalls>();
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

      const uniqueRepos = new Set(clients.map((c) => c.repo));
      const riskLevel = uniqueRepos.size >= 3 ? 'critical'
        : uniqueRepos.size >= 2 ? 'high'
        : clients.length >= 3 ? 'medium' : 'low';

      // Find the service and repo for this endpoint
      const svc = this.topoStore.getAllServices().find((s) => s.id === ep.service_id);
      const repo = svc
        ? this.topoStore.getFederatedRepo(svc.repo_root)
        : undefined;

      // Check for schema-level breaking changes via contract snapshots
      let breakingChanges: EndpointSchemaDiff[] | undefined;
      const contracts = this.topoStore.getContractsByService(ep.service_id);
      for (const contract of contracts) {
        const snapshot = this.topoStore.getLatestSnapshot(contract.id);
        if (!snapshot) continue;

        let oldEndpoints: Array<{ method: string | null; path: string; requestSchema?: string; responseSchema?: string }> = [];
        try {
          const parsed = JSON.parse(snapshot.endpoints_json) as { endpoints?: Array<{ method?: string; path: string; requestSchema?: string; responseSchema?: string }> };
          oldEndpoints = (parsed.endpoints ?? []).map((e) => ({ method: e.method ?? null, path: e.path, requestSchema: e.requestSchema, responseSchema: e.responseSchema }));
        } catch { continue; }

        // Get current endpoint schemas
        const currentEndpoints = this.topoStore.getEndpointsByService(ep.service_id).map((e) => ({
          method: e.method,
          path: e.path,
          requestSchema: e.request_schema,
          responseSchema: e.response_schema,
        }));

        const epDiffs = diffEndpoints(oldEndpoints, currentEndpoints)
          .filter((d) => d.endpoint.path === ep.path && (d.endpoint.method ?? '*') === (ep.method ?? '*'));

        if (epDiffs.length > 0 && epDiffs.some((d) => d.breaking)) {
          breakingChanges = epDiffs;
        }
      }

      // Upgrade risk level if breaking schema changes exist
      let finalRiskLevel = riskLevel;
      if (breakingChanges?.some((d) => d.breaking)) {
        const riskLevels: Array<CrossRepoImpactResult['riskLevel']> = ['low', 'medium', 'high', 'critical'];
        const idx = riskLevels.indexOf(riskLevel);
        if (idx < riskLevels.length - 1) finalRiskLevel = riskLevels[idx + 1];
      }

      results.push({
        endpoint: {
          method: ep.method,
          path: ep.path,
          service: ep.service_name,
          repo: repo?.name ?? svc?.repo_root ?? 'unknown',
        },
        clients,
        riskLevel: finalRiskLevel,
        summary: `${ep.method ?? '*'} ${ep.path} is called by ${clients.length} client(s) in ${uniqueRepos.size} repo(s)${breakingChanges ? ' ⚠ BREAKING SCHEMA CHANGES' : ''}`,
        breakingChanges,
      });
    }

    return results;
  }

  /**
   * Search across all federated repos. Opens each per-repo DB readonly,
   * runs FTS search, normalizes scores, merges results.
   */
  federatedSearch(
    query: string,
    filters?: { kind?: string; language?: string; filePattern?: string },
    limit = 20,
  ): FederatedSearchResult {
    const repos = this.topoStore.getAllFederatedRepos();
    const allItems: FederatedSearchItem[] = [];
    let reposSearched = 0;

    for (const repo of repos) {
      if (!repo.db_path || !fs.existsSync(repo.db_path)) continue;

      let db: Database.Database | null = null;
      try {
        db = new Database(repo.db_path, { readonly: true });
        db.pragma('busy_timeout = 3000');

        const ftsResults = searchFts(db, query, limit, 0, {
          kind: filters?.kind,
          language: filters?.language,
          filePattern: filters?.filePattern,
        });

        if (ftsResults.length === 0) continue;
        reposSearched++;

        // Normalize BM25 scores within this repo (rank is negative, lower = better)
        const minRank = Math.min(...ftsResults.map((r) => r.rank));
        const maxRank = Math.max(...ftsResults.map((r) => r.rank));
        const rankSpread = maxRank - minRank || 1;

        // Batch-fetch file paths and symbol lines
        const symbolIds = ftsResults.map((r) => r.symbolId);
        const symbolRows = db.prepare(
          `SELECT s.id, s.symbol_id, s.name, s.kind, s.fqn, s.signature, s.line_start, f.path as file_path
           FROM symbols s JOIN files f ON f.id = s.file_id
           WHERE s.id IN (${symbolIds.map(() => '?').join(',')})`,
        ).all(...symbolIds) as Array<{
          id: number; symbol_id: string; name: string; kind: string;
          fqn: string | null; signature: string | null; line_start: number | null;
          file_path: string;
        }>;

        const symbolMap = new Map(symbolRows.map((s) => [s.id, s]));

        for (const fts of ftsResults) {
          const sym = symbolMap.get(fts.symbolId);
          if (!sym) continue;

          allItems.push({
            repo: repo.name,
            symbol_id: sym.symbol_id,
            name: sym.name,
            kind: sym.kind,
            fqn: sym.fqn,
            signature: sym.signature,
            file: sym.file_path,
            line: sym.line_start,
            score: 1 - (fts.rank - minRank) / rankSpread,
          });
        }
      } catch (e) {
        logger.warn({ repo: repo.name, error: e }, 'Failed to search federated repo');
      } finally {
        db?.close();
      }
    }

    // Sort by score descending and apply global limit
    allItems.sort((a, b) => b.score - a.score);

    return {
      items: allItems.slice(0, limit),
      total: allItems.length,
      repos_searched: reposSearched,
    };
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

// ════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════

/**
 * Open a per-repo DB and find symbols at a given file:line location.
 */
function resolveSymbolsAtLocation(
  dbPath: string,
  filePath: string,
  line: number | null,
): Array<{ symbolId: string; name: string; kind: string; fqn: string | null }> {
  if (!line) return [];

  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.prepare(`
        SELECT s.symbol_id, s.name, s.kind, s.fqn
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE f.path LIKE ? AND s.line_start <= ? AND (s.line_end >= ? OR s.line_end IS NULL)
        ORDER BY (s.line_end - s.line_start) ASC
        LIMIT 5
      `).all(`%${filePath}`, line, line) as Array<{
        symbol_id: string;
        name: string;
        kind: string;
        fqn: string | null;
      }>;

      return rows.map((r) => ({
        symbolId: r.symbol_id,
        name: r.name,
        kind: r.kind,
        fqn: r.fqn,
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
