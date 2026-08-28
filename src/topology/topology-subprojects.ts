/**
 * Subproject operations — extracted from `TopologyStore` (god-class
 * decomposition). Owns the `subprojects` table surface plus `removeByRepoRoot`,
 * the whole-repo teardown that spans services + subprojects + client_calls.
 *
 * `removeByRepoRoot` needs `ServiceOperations.deleteService` to cascade service
 * rows; that single cross-entity dependency is threaded in via the `deps`
 * callback object (same pattern `DecisionStore` uses for its consolidation ops)
 * rather than importing `ServiceOperations` back, which would risk a cycle.
 */

import path from 'node:path';
import type Database from 'better-sqlite3';
import { isDangerousProjectRoot } from '../dangerous-root.js';
import type { SubprojectRow } from './topology-types.js';

/**
 * Reject a subproject registration whose repo_root or project_root is a
 * filesystem root / home / system directory.
 *
 * repo_root="/" makes `findSubprojectRootForPath` resolve every unregistered
 * path to it (#273). project_root="/private/tmp" is the TRA-232 case: the
 * Claude-session discovery path (`discoverAndRegisterSubprojects`) hands
 * `autoDiscoverSubprojects` a decoded session cwd, so a session started in
 * /tmp made trace-mcp walk the whole scratch directory and register every
 * throwaway folder under it as a subproject (298 phantom rows in the field).
 * `setupProject` has refused these roots since TRA-185; the subproject table
 * is a second registration surface that was never routed through the same
 * guard. Returns null when acceptable, or a reason string.
 */
function dangerousSubprojectRoot(repoRoot: string, projectRoot: string): string | null {
  const repoReason = isDangerousProjectRoot(path.resolve(repoRoot));
  if (repoReason) return `repo_root "${repoRoot}": ${repoReason}`;
  const projectReason = isDangerousProjectRoot(path.resolve(projectRoot));
  if (projectReason) return `project_root "${projectRoot}": ${projectReason}`;
  return null;
}

/**
 * Delete subproject rows (plus the services rooted under them) whose roots
 * `dangerousSubprojectRoot` now rejects — self-heals registries polluted
 * before the guard existed. Raw SQL because this runs from `TopologyStore`'s
 * migrate(), before the operation modules are constructed.
 */
export function pruneDangerousSubprojects(db: Database.Database): {
  subprojects: number;
  services: number;
} {
  const rows = db.prepare('SELECT id, repo_root, project_root FROM subprojects').all() as Array<{
    id: number;
    repo_root: string;
    project_root: string;
  }>;
  const bad = rows.filter((r) => dangerousSubprojectRoot(r.repo_root, r.project_root) !== null);
  if (bad.length === 0) return { subprojects: 0, services: 0 };

  const badIds = bad.map((r) => r.id);
  const badIdSet = new Set(badIds);
  // A repo_root can be shared with a still-valid subproject; only drop services
  // whose root belongs exclusively to pruned rows.
  const survivingRoots = new Set(rows.filter((r) => !badIdSet.has(r.id)).map((r) => r.repo_root));
  const orphanRoots = [...new Set(bad.map((r) => r.repo_root))].filter(
    (root) => !survivingRoots.has(root),
  );

  let services = 0;
  db.transaction(() => {
    if (orphanRoots.length > 0) {
      const rootPlaceholders = orphanRoots.map(() => '?').join(',');
      // Same FK dance as removeByRepoRoot(): client_calls.matched_endpoint_id
      // has no ON DELETE, so detach before the service cascade drops endpoints.
      db.prepare(
        `UPDATE client_calls SET matched_endpoint_id = NULL
         WHERE matched_endpoint_id IN (
           SELECT e.id FROM api_endpoints e
           JOIN services s ON s.id = e.service_id
           WHERE s.repo_root IN (${rootPlaceholders})
         )`,
      ).run(...orphanRoots);
      services = db
        .prepare(`DELETE FROM services WHERE repo_root IN (${rootPlaceholders})`)
        .run(...orphanRoots).changes;
    }

    const idPlaceholders = badIds.map(() => '?').join(',');
    // client_calls.target_repo_id has no ON DELETE either — detach first.
    db.prepare(
      `UPDATE client_calls SET target_repo_id = NULL WHERE target_repo_id IN (${idPlaceholders})`,
    ).run(...badIds);
    db.prepare(`DELETE FROM subprojects WHERE id IN (${idPlaceholders})`).run(...badIds);
  })();

  return { subprojects: badIds.length, services };
}

export interface SubprojectOperationDeps {
  /** Delete a service row (cascades to its contracts/endpoints/events/edges/snapshots). */
  deleteService(id: number): void;
}

export class SubprojectOperations {
  constructor(
    private readonly db: Database.Database,
    private readonly deps: SubprojectOperationDeps,
  ) {}

  upsertSubproject(input: {
    name: string;
    repoRoot: string;
    projectRoot: string;
    dbPath?: string;
    contractPaths?: string[];
    metadata?: Record<string, unknown>;
  }): number {
    const dangerReason = dangerousSubprojectRoot(input.repoRoot, input.projectRoot);
    if (dangerReason) {
      throw new Error(
        `Refusing to register subproject — ${dangerReason}. ` +
          'This is almost always a bad detection result: a subproject must point to a ' +
          'specific repo directory inside a specific project, not a system or root path.',
      );
    }

    const existing = this.db
      .prepare('SELECT id FROM subprojects WHERE repo_root = ? AND project_root = ?')
      .get(input.repoRoot, input.projectRoot) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare(`
        UPDATE subprojects SET name = ?, db_path = COALESCE(?, db_path),
          contract_paths = COALESCE(?, contract_paths),
          metadata = COALESCE(?, metadata), last_synced = datetime('now')
        WHERE id = ?
      `)
        .run(
          input.name,
          input.dbPath ?? null,
          input.contractPaths ? JSON.stringify(input.contractPaths) : null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          existing.id,
        );
      return existing.id;
    }

    return this.db
      .prepare(`
      INSERT INTO subprojects (name, repo_root, project_root, db_path, contract_paths, metadata, added_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `)
      .run(
        input.name,
        input.repoRoot,
        input.projectRoot,
        input.dbPath ?? null,
        input.contractPaths ? JSON.stringify(input.contractPaths) : null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ).lastInsertRowid as number;
  }

  getSubproject(nameOrRoot: string, projectRoot?: string): SubprojectRow | undefined {
    if (projectRoot) {
      return this.db
        .prepare('SELECT * FROM subprojects WHERE (name = ? OR repo_root = ?) AND project_root = ?')
        .get(nameOrRoot, nameOrRoot, projectRoot) as SubprojectRow | undefined;
    }
    return this.db
      .prepare('SELECT * FROM subprojects WHERE name = ? OR repo_root = ?')
      .get(nameOrRoot, nameOrRoot) as SubprojectRow | undefined;
  }

  getSubprojectsByProject(projectRoot: string): SubprojectRow[] {
    return this.db
      .prepare('SELECT * FROM subprojects WHERE project_root = ? ORDER BY name')
      .all(projectRoot) as SubprojectRow[];
  }

  getAllSubprojects(): SubprojectRow[] {
    return this.db.prepare('SELECT * FROM subprojects ORDER BY name').all() as SubprojectRow[];
  }

  deleteSubproject(id: number): void {
    this.db.prepare('DELETE FROM subprojects WHERE id = ?').run(id);
  }

  /**
   * Remove all topology data associated with a repo root:
   * subprojects (+ cascading client_calls), services (+ cascading contracts,
   * endpoints, events, edges, snapshots).
   * Returns counts of deleted rows for logging.
   */
  removeByRepoRoot(repoRoot: string): { subprojects: number; services: number } {
    const result = { subprojects: 0, services: 0 };

    const services = this.db
      .prepare('SELECT id FROM services WHERE repo_root = ?')
      .all(repoRoot) as Array<{ id: number }>;

    // Whole removal runs in ONE transaction so a mid-way FK failure can't leave
    // a half-deleted repo behind.
    this.db.transaction(() => {
      if (services.length > 0) {
        // client_calls.matched_endpoint_id REFERENCES api_endpoints(id) with NO
        // `ON DELETE` action — so deleting a service (which cascade-deletes its
        // api_endpoints) throws "FOREIGN KEY constraint failed" whenever ANOTHER
        // repo's client call matched one of those endpoints. Detach those
        // references first (the column is nullable), then the cascade is safe.
        const placeholders = services.map(() => '?').join(',');
        const ids = services.map((s) => s.id);
        this.db
          .prepare(
            `UPDATE client_calls SET matched_endpoint_id = NULL
             WHERE matched_endpoint_id IN (
               SELECT id FROM api_endpoints WHERE service_id IN (${placeholders})
             )`,
          )
          .run(...ids);

        // Delete all services rooted in this path (cascades to contracts,
        // endpoints, events, edges, snapshots).
        for (const svc of services) {
          this.deps.deleteService(svc.id);
        }
        result.services = services.length;
      }

      // Delete subproject entry last. source_repo_id cascades, but
      // client_calls.target_repo_id REFERENCES subprojects(id) has NO `ON DELETE`
      // — other repos pointing AT this one would block the delete. Detach first.
      const sub = this.getSubproject(repoRoot);
      if (sub) {
        this.db
          .prepare('UPDATE client_calls SET target_repo_id = NULL WHERE target_repo_id = ?')
          .run(sub.id);
        this.deleteSubproject(sub.id);
        result.subprojects = 1;
      }
    })();

    return result;
  }

  updateSubprojectSyncTime(id: number): void {
    this.db.prepare("UPDATE subprojects SET last_synced = datetime('now') WHERE id = ?").run(id);
  }
}
