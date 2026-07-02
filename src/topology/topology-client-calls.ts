/**
 * Client-call operations — extracted from `TopologyStore` (god-class
 * decomposition). Owns the `client_calls` table surface plus
 * `linkClientCallsToEndpoints`, the URL→endpoint matcher.
 *
 * The linker reads across entities (endpoints, services, subprojects). The pure
 * matcher `findBestEndpointMatch` is imported directly from the endpoints module
 * (a leaf pure function — no cycle), while the three cross-entity "get all"
 * reads are threaded in via the `deps` callback object (same pattern
 * `DecisionStore` uses for its consolidation ops) rather than importing the
 * sibling operation classes back.
 */

import type Database from 'better-sqlite3';
import { findBestEndpointMatch } from './topology-endpoints.js';
import type { ClientCallRow, EndpointRow, ServiceRow, SubprojectRow } from './topology-types.js';

export interface ClientCallOperationDeps {
  getAllEndpoints(): Array<EndpointRow & { service_name: string }>;
  getAllServices(): ServiceRow[];
  getAllSubprojects(): SubprojectRow[];
}

type ScoredEndpoints = Array<EndpointRow & { service_name: string }>;

/**
 * Pre-built lookup maps for {@link ClientCallOperations.linkClientCallsToEndpoints}.
 * Building these once up front turns the linker's inner loop from an
 * O(calls × endpoints) scan (with repeated per-call SELECTs) into O(1) lookups.
 */
interface LinkLookups {
  /** service_id → repo_root (replaces a per-matched-call `SELECT repo_root FROM services`). */
  serviceRepoRoot: Map<number, string>;
  /** repo_root → subproject_id (replaces a per-matched-call `SELECT id FROM subprojects`). */
  repoIdByRoot: Map<string, number>;
  /** source_repo_id → { group, serviceId } for the calling repo. */
  repoInfo: Map<number, { group: string | null; serviceId: number | null }>;
  /** project_group → endpoints in that group, grouped once. */
  endpointsByGroup: Map<string | null, ScoredEndpoints>;
}

/**
 * Build the {@link LinkLookups} the linker needs from the full service / repo /
 * endpoint snapshots. Pure — depends only on its inputs.
 */
function buildLinkLookups(
  services: ServiceRow[],
  allRepos: SubprojectRow[],
  endpoints: ScoredEndpoints,
): LinkLookups {
  const serviceGroup = new Map<number, string | null>();
  const serviceRepoRoot = new Map<number, string>();
  const serviceByRepoRoot = new Map<string, ServiceRow>();
  for (const svc of services) {
    serviceGroup.set(svc.id, svc.project_group ?? null);
    serviceRepoRoot.set(svc.id, svc.repo_root);
    if (!serviceByRepoRoot.has(svc.repo_root)) serviceByRepoRoot.set(svc.repo_root, svc);
  }

  const repoIdByRoot = new Map<string, number>();
  const repoInfo = new Map<number, { group: string | null; serviceId: number | null }>();
  for (const repo of allRepos) {
    if (!repoIdByRoot.has(repo.repo_root)) repoIdByRoot.set(repo.repo_root, repo.id);
    const svc = serviceByRepoRoot.get(repo.repo_root);
    repoInfo.set(repo.id, { group: svc?.project_group ?? null, serviceId: svc?.id ?? null });
  }

  // Pre-group endpoints by project_group once (was previously an O(endpoints) `.filter()`
  // re-run for EVERY unlinked call — with thousands of calls and endpoints this dominated
  // reindex time; see plan-indexer-perf topology hotspot).
  const endpointsByGroup = new Map<string | null, ScoredEndpoints>();
  for (const ep of endpoints) {
    const epGroup = serviceGroup.get(ep.service_id) ?? null;
    const list = endpointsByGroup.get(epGroup);
    if (list) list.push(ep);
    else endpointsByGroup.set(epGroup, [ep]);
  }

  return { serviceRepoRoot, repoIdByRoot, repoInfo, endpointsByGroup };
}

/**
 * Split a group's endpoints into { self, other } relative to the calling
 * service. Self-first matching prevents cross-project false positives when
 * multiple services share identical route paths (e.g., copy-pasted Nova
 * components across Laravel apps). Pure.
 */
function splitEndpointsBySelf(
  groupEndpoints: ScoredEndpoints,
  sourceServiceId: number | null,
): { self: ScoredEndpoints; other: ScoredEndpoints } {
  const self: ScoredEndpoints = [];
  const other: ScoredEndpoints = [];
  for (const ep of groupEndpoints) {
    if (sourceServiceId != null && ep.service_id === sourceServiceId) self.push(ep);
    else other.push(ep);
  }
  return { self, other };
}

export class ClientCallOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly deps: ClientCallOperationDeps,
  ) {}

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
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO client_calls
        (source_repo_id, target_repo_id, file_path, line, call_type, method, url_pattern,
         matched_endpoint_id, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.transaction(() => {
      for (const c of calls) {
        stmt.run(
          c.sourceRepoId,
          c.targetRepoId ?? null,
          c.filePath,
          c.line ?? null,
          c.callType,
          c.method ?? null,
          c.urlPattern,
          c.matchedEndpointId ?? null,
          c.confidence ?? 0.5,
          c.metadata ? JSON.stringify(c.metadata) : null,
        );
      }
    })();
  }

  deleteClientCallsByRepo(repoId: number): void {
    this.db.prepare('DELETE FROM client_calls WHERE source_repo_id = ?').run(repoId);
  }

  getClientCallsByEndpoint(
    endpointId: number,
  ): Array<ClientCallRow & { source_repo_name: string }> {
    return this.db
      .prepare(`
      SELECT cc.*, sp.name as source_repo_name FROM client_calls cc
      JOIN subprojects sp ON cc.source_repo_id = sp.id
      WHERE cc.matched_endpoint_id = ?
      ORDER BY cc.confidence DESC
    `)
      .all(endpointId) as Array<ClientCallRow & { source_repo_name: string }>;
  }

  getClientCallsByRepo(repoId: number): ClientCallRow[] {
    return this.db
      .prepare('SELECT * FROM client_calls WHERE source_repo_id = ? ORDER BY file_path, line')
      .all(repoId) as ClientCallRow[];
  }

  getClientCallsForTarget(
    targetRepoId: number,
  ): Array<ClientCallRow & { source_repo_name: string }> {
    return this.db
      .prepare(`
      SELECT cc.*, sp.name as source_repo_name FROM client_calls cc
      JOIN subprojects sp ON cc.source_repo_id = sp.id
      WHERE cc.target_repo_id = ?
      ORDER BY cc.confidence DESC
    `)
      .all(targetRepoId) as Array<ClientCallRow & { source_repo_name: string }>;
  }

  /** Match unlinked client calls to known endpoints. Returns number of newly linked calls. */
  linkClientCallsToEndpoints(): number {
    // Match by URL pattern similarity, respecting project_group isolation.
    // fair-front should only match fair-laravel endpoints, not thewed-laravel's.
    const unlinked = this.db
      .prepare('SELECT * FROM client_calls WHERE matched_endpoint_id IS NULL')
      .all() as ClientCallRow[];

    const { serviceRepoRoot, repoIdByRoot, repoInfo, endpointsByGroup } = buildLinkLookups(
      this.deps.getAllServices(),
      this.deps.getAllSubprojects(),
      this.deps.getAllEndpoints(),
    );

    // Cache of (group, serviceId) → { self, other } endpoint subsets, built lazily since the
    // number of distinct (group, serviceId) pairs actually hit is typically far smaller than
    // the number of unlinked calls.
    const splitCache = new Map<string, { self: ScoredEndpoints; other: ScoredEndpoints }>();

    let linked = 0;

    const updateStmt = this.db.prepare(
      'UPDATE client_calls SET matched_endpoint_id = ?, target_repo_id = ?, confidence = ? WHERE id = ?',
    );

    this.db.transaction(() => {
      for (const call of unlinked) {
        const info = repoInfo.get(call.source_repo_id);
        const sourceGroup = info?.group ?? null;
        const sourceServiceId = info?.serviceId ?? null;

        const splitKey = `${sourceGroup ?? ''} ${sourceServiceId ?? ''}`;
        let split = splitCache.get(splitKey);
        if (!split) {
          split = splitEndpointsBySelf(endpointsByGroup.get(sourceGroup) ?? [], sourceServiceId);
          splitCache.set(splitKey, split);
        }

        // Self-first matching: prefer endpoints from the SAME service as the client call,
        // then fall back to other services in the same group only if no self-match found.
        const match =
          (sourceServiceId != null
            ? findBestEndpointMatch(call.url_pattern, call.method, split.self)
            : null) ?? findBestEndpointMatch(call.url_pattern, call.method, split.other);

        if (match) {
          // Find the repo for this service via pre-built maps (was two per-call SELECTs).
          const matchRepoRoot = serviceRepoRoot.get(match.service_id);
          const targetRepoId =
            matchRepoRoot != null ? (repoIdByRoot.get(matchRepoRoot) ?? null) : null;

          updateStmt.run(match.id, targetRepoId ?? null, match.confidence, call.id);
          linked++;
        }
      }
    })();

    return linked;
  }
}
