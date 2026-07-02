/**
 * Service operations — extracted from `TopologyStore` (god-class
 * decomposition). Owns the `services` table surface: upsert, lookups, group
 * updates, endpoint-count aggregation, and deletion.
 *
 * Depends only on the raw `Database` handle; `TopologyStore` holds one instance
 * and delegates its public service methods to it verbatim.
 */

import type Database from 'better-sqlite3';
import type { ServiceRow } from './topology-types.js';

export class ServiceOperations {
  constructor(private readonly db: Database.Database) {}

  upsertService(input: {
    name: string;
    repoRoot: string;
    dbPath: string;
    serviceType?: string;
    detectionSource?: string;
    projectGroup?: string;
    metadata?: Record<string, unknown>;
  }): number {
    const existing = this.db.prepare('SELECT id FROM services WHERE name = ?').get(input.name) as
      | { id: number }
      | undefined;
    if (existing) {
      this.db
        .prepare(`
        UPDATE services SET repo_root = ?, db_path = ?, service_type = COALESCE(?, service_type),
          detection_source = COALESCE(?, detection_source),
          project_group = COALESCE(?, project_group),
          metadata = COALESCE(?, metadata),
          indexed_at = datetime('now')
        WHERE id = ?
      `)
        .run(
          input.repoRoot,
          input.dbPath,
          input.serviceType ?? null,
          input.detectionSource ?? null,
          input.projectGroup ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          existing.id,
        );
      return existing.id;
    }

    return this.db
      .prepare(`
      INSERT INTO services (name, repo_root, db_path, service_type, detection_source, project_group, metadata, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `)
      .run(
        input.name,
        input.repoRoot,
        input.dbPath,
        input.serviceType ?? null,
        input.detectionSource ?? null,
        input.projectGroup ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ).lastInsertRowid as number;
  }

  getService(name: string): ServiceRow | undefined {
    return this.db.prepare('SELECT * FROM services WHERE name = ?').get(name) as
      | ServiceRow
      | undefined;
  }

  getAllServices(): ServiceRow[] {
    return this.db.prepare('SELECT * FROM services ORDER BY name').all() as ServiceRow[];
  }

  updateServiceGroup(serviceId: number, projectGroup: string | null): void {
    this.db
      .prepare('UPDATE services SET project_group = ? WHERE id = ?')
      .run(projectGroup, serviceId);
  }

  getServicesWithEndpointCounts(
    projectRoot?: string,
  ): Array<ServiceRow & { endpoint_count: number }> {
    if (projectRoot) {
      return this.db
        .prepare(`
        SELECT s.*, (SELECT COUNT(*) FROM api_endpoints WHERE service_id = s.id) as endpoint_count
        FROM services s
        WHERE s.repo_root IN (SELECT repo_root FROM subprojects WHERE project_root = ?)
        ORDER BY s.project_group NULLS LAST, s.name
      `)
        .all(projectRoot) as Array<ServiceRow & { endpoint_count: number }>;
    }
    return this.db
      .prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM api_endpoints WHERE service_id = s.id) as endpoint_count
      FROM services s ORDER BY s.project_group NULLS LAST, s.name
    `)
      .all() as Array<ServiceRow & { endpoint_count: number }>;
  }

  deleteService(id: number): void {
    this.db.prepare('DELETE FROM services WHERE id = ?').run(id);
  }
}
