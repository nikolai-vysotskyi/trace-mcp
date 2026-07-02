/**
 * Cross-service edge operations — extracted from `TopologyStore` (god-class
 * decomposition). Owns the `cross_service_edges` table surface: insert and the
 * source/target/all edge lookups.
 *
 * Depends only on the raw `Database` handle; `TopologyStore` holds one instance
 * and delegates its public cross-service-edge methods to it verbatim.
 */

import type Database from 'better-sqlite3';
import type { CrossServiceEdgeRow } from './topology-types.js';

export class CrossServiceEdgeOperations {
  constructor(private readonly db: Database.Database) {}

  insertCrossServiceEdge(input: {
    sourceServiceId: number;
    targetServiceId: number;
    edgeType: string;
    sourceRef?: string;
    targetRef?: string;
    confidence?: number;
    metadata?: Record<string, unknown>;
  }): number {
    return this.db
      .prepare(`
      INSERT OR IGNORE INTO cross_service_edges
        (source_service_id, target_service_id, edge_type, source_ref, target_ref, confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .run(
        input.sourceServiceId,
        input.targetServiceId,
        input.edgeType,
        input.sourceRef ?? null,
        input.targetRef ?? null,
        input.confidence ?? 1.0,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ).lastInsertRowid as number;
  }

  getAllCrossServiceEdges(): Array<
    CrossServiceEdgeRow & { source_name: string; target_name: string }
  > {
    return this.db
      .prepare(`
      SELECT e.*, s1.name as source_name, s2.name as target_name
      FROM cross_service_edges e
      JOIN services s1 ON e.source_service_id = s1.id
      JOIN services s2 ON e.target_service_id = s2.id
      ORDER BY e.confidence DESC
    `)
      .all() as Array<CrossServiceEdgeRow & { source_name: string; target_name: string }>;
  }

  getEdgesBySource(serviceId: number): Array<CrossServiceEdgeRow & { target_name: string }> {
    return this.db
      .prepare(`
      SELECT e.*, s.name as target_name FROM cross_service_edges e
      JOIN services s ON e.target_service_id = s.id
      WHERE e.source_service_id = ?
    `)
      .all(serviceId) as Array<CrossServiceEdgeRow & { target_name: string }>;
  }

  getEdgesByTarget(serviceId: number): Array<CrossServiceEdgeRow & { source_name: string }> {
    return this.db
      .prepare(`
      SELECT e.*, s.name as source_name FROM cross_service_edges e
      JOIN services s ON e.source_service_id = s.id
      WHERE e.target_service_id = ?
    `)
      .all(serviceId) as Array<CrossServiceEdgeRow & { source_name: string }>;
  }
}
