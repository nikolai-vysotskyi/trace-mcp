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
import type { SubprojectRow } from './topology-types.js';

/**
 * True when `repoRoot` IS a filesystem root ("/", "C:\"), not merely close to
 * one. A row like this makes `findSubprojectRootForPath` resolve every
 * unregistered path to it (longest-ancestor-match logic sees "/" as an
 * ancestor of everything) — see #273. Same guard class as
 * `isDangerousProjectRoot` in project-setup.ts, scoped to just the root case
 * since a subproject is always nested under a project.
 */
function isFilesystemRoot(repoRoot: string): boolean {
  const resolved = path.resolve(repoRoot);
  return resolved === path.parse(resolved).root;
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
    if (isFilesystemRoot(input.repoRoot)) {
      throw new Error(
        `Refusing to register subproject repo_root "${input.repoRoot}": filesystem root. ` +
          'This is almost always a bad detection result — a subproject must point to a ' +
          'specific repo directory, not "/".',
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
