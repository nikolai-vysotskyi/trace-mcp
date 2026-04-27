import type Database from 'better-sqlite3';
import type { TraceMcpResult } from '../../errors.js';
import { ok, err } from '../../errors.js';
import { dbError } from '../../errors.js';
import type { EdgeRow } from '../types.js';

export interface EdgeTypeRow {
  name: string;
  category: string;
  description: string;
}

export class GraphRepository {
  private readonly _stmts: {
    getNodeId: Database.Statement;
    createNodeInsert: Database.Statement;
    createNodeSelect: Database.Statement;
    getNodeRef: Database.Statement;
    getEdgeType: Database.Statement;
    insertEdge: Database.Statement;
  };

  constructor(private readonly db: Database.Database) {
    this._stmts = {
      getNodeId: db.prepare('SELECT id FROM nodes WHERE node_type = ? AND ref_id = ?'),
      createNodeInsert: db.prepare('INSERT OR IGNORE INTO nodes (node_type, ref_id) VALUES (?, ?)'),
      createNodeSelect: db.prepare('SELECT id FROM nodes WHERE node_type = ? AND ref_id = ?'),
      getNodeRef: db.prepare(
        'SELECT node_type AS nodeType, ref_id AS refId FROM nodes WHERE id = ?',
      ),
      getEdgeType: db.prepare('SELECT id FROM edge_types WHERE name = ?'),
      insertEdge: db.prepare(
        `INSERT INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws, resolution_tier)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_node_id, target_node_id, edge_type_id)
         DO UPDATE SET metadata = excluded.metadata, resolved = excluded.resolved, resolution_tier = excluded.resolution_tier`,
      ),
    };
  }

  createNode(nodeType: string, refId: number): number {
    this._stmts.createNodeInsert.run(nodeType, refId);
    return (this._stmts.createNodeSelect.get(nodeType, refId) as { id: number }).id;
  }

  getNodeId(nodeType: string, refId: number): number | undefined {
    return (this._stmts.getNodeId.get(nodeType, refId) as { id: number } | undefined)?.id;
  }

  insertEdge(
    sourceNodeId: number,
    targetNodeId: number,
    edgeTypeName: string,
    resolved = true,
    metadata?: Record<string, unknown>,
    isCrossWs = false,
    resolutionTier: string = 'ast_resolved',
  ): TraceMcpResult<number> {
    const edgeType = this._stmts.getEdgeType.get(edgeTypeName) as { id: number } | undefined;
    if (!edgeType) {
      return err(dbError(`Unknown edge type: ${edgeTypeName}`));
    }

    try {
      const result = this._stmts.insertEdge.run(
        sourceNodeId,
        targetNodeId,
        edgeType.id,
        resolved ? 1 : 0,
        metadata ? JSON.stringify(metadata) : null,
        isCrossWs ? 1 : 0,
        resolutionTier,
      );
      return ok(Number(result.lastInsertRowid));
    } catch (e) {
      return err(dbError(e instanceof Error ? e.message : String(e)));
    }
  }

  deleteEdgesForFileNodes(fileId: number): void {
    this.db
      .prepare(`
      DELETE FROM edges WHERE source_node_id IN (
        SELECT n.id FROM nodes n
        WHERE (n.node_type = 'file' AND n.ref_id = ?)
           OR (n.node_type = 'symbol' AND n.ref_id IN (SELECT id FROM symbols WHERE file_id = ?))
      ) OR target_node_id IN (
        SELECT n.id FROM nodes n
        WHERE (n.node_type = 'file' AND n.ref_id = ?)
           OR (n.node_type = 'symbol' AND n.ref_id IN (SELECT id FROM symbols WHERE file_id = ?))
      )
    `)
      .run(fileId, fileId, fileId, fileId);
  }

  deleteOutgoingImportEdges(fileId: number): void {
    this.db
      .prepare(`
      DELETE FROM edges WHERE source_node_id IN (
        SELECT n.id FROM nodes n WHERE n.node_type = 'file' AND n.ref_id = ?
      ) AND edge_type_id = (SELECT id FROM edge_types WHERE name = 'imports')
    `)
      .run(fileId);
  }

  deleteOutgoingEdgesForFileNodes(fileId: number): void {
    this.db
      .prepare(`
      DELETE FROM edges WHERE source_node_id IN (
        SELECT n.id FROM nodes n
        WHERE (n.node_type = 'file' AND n.ref_id = ?)
           OR (n.node_type = 'symbol' AND n.ref_id IN (SELECT id FROM symbols WHERE file_id = ?))
      )
    `)
      .run(fileId, fileId);
  }

  traverseEdges(startNodeId: number, direction: 'outgoing' | 'incoming', depth: number): EdgeRow[] {
    const directionCol = direction === 'outgoing' ? 'source_node_id' : 'target_node_id';
    const otherCol = direction === 'outgoing' ? 'target_node_id' : 'source_node_id';

    const sql = `
      WITH RECURSIVE traverse(node_id, depth) AS (
        SELECT ?, 0
        UNION ALL
        SELECT e.${otherCol}, t.depth + 1
        FROM edges e
        JOIN traverse t ON e.${directionCol} = t.node_id
        WHERE t.depth < ?
      )
      SELECT DISTINCT e.*
      FROM traverse t
      JOIN edges e ON e.${directionCol} = t.node_id
      WHERE t.depth < ?
    `;

    return this.db.prepare(sql).all(startNodeId, depth, depth) as EdgeRow[];
  }

  getEdgesByType(edgeTypeName: string): EdgeRow[] {
    const edgeType = this.db
      .prepare('SELECT id FROM edge_types WHERE name = ?')
      .get(edgeTypeName) as { id: number } | undefined;
    if (!edgeType) return [];
    return this.db
      .prepare('SELECT * FROM edges WHERE edge_type_id = ?')
      .all(edgeType.id) as EdgeRow[];
  }

  getOutgoingEdges(nodeId: number): (EdgeRow & { edge_type_name: string })[] {
    return this.db
      .prepare(
        `SELECT e.*, et.name as edge_type_name
       FROM edges e JOIN edge_types et ON e.edge_type_id = et.id
       WHERE e.source_node_id = ?`,
      )
      .all(nodeId) as (EdgeRow & { edge_type_name: string })[];
  }

  getIncomingEdges(nodeId: number): (EdgeRow & { edge_type_name: string })[] {
    return this.db
      .prepare(
        `SELECT e.*, et.name as edge_type_name
       FROM edges e JOIN edge_types et ON e.edge_type_id = et.id
       WHERE e.target_node_id = ?`,
      )
      .all(nodeId) as (EdgeRow & { edge_type_name: string })[];
  }

  ensureEdgeType(name: string, category: string, description: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO edge_types (name, category, directed, description) VALUES (?, ?, 1, ?)',
      )
      .run(name, category, description);
  }

  getEdgeTypeName(edgeTypeId: number): string | undefined {
    const row = this.db.prepare('SELECT name FROM edge_types WHERE id = ?').get(edgeTypeId) as
      | { name: string }
      | undefined;
    return row?.name;
  }

  getNodeRef(nodeId: number): { nodeType: string; refId: number } | undefined {
    return this._stmts.getNodeRef.get(nodeId) as { nodeType: string; refId: number } | undefined;
  }

  getNodeByNodeId(nodeId: number): { node_type: string; ref_id: number } | undefined {
    return this.db.prepare('SELECT node_type, ref_id FROM nodes WHERE id = ?').get(nodeId) as
      | { node_type: string; ref_id: number }
      | undefined;
  }

  getNodeIdsBatch(nodeType: string, refIds: number[]): Map<number, number> {
    const map = new Map<number, number>();
    if (refIds.length === 0) return map;
    const CHUNK = 900;
    for (let i = 0; i < refIds.length; i += CHUNK) {
      const chunk = refIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT ref_id, id FROM nodes WHERE node_type = ? AND ref_id IN (${placeholders})`)
        .all(nodeType, ...chunk) as { ref_id: number; id: number }[];
      for (const row of rows) map.set(row.ref_id, row.id);
    }
    return map;
  }

  getNodeRefsBatch(nodeIds: number[]): Map<number, { nodeType: string; refId: number }> {
    const map = new Map<number, { nodeType: string; refId: number }>();
    if (nodeIds.length === 0) return map;
    const CHUNK = 900;
    for (let i = 0; i < nodeIds.length; i += CHUNK) {
      const chunk = nodeIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT id, node_type, ref_id FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as { id: number; node_type: string; ref_id: number }[];
      for (const row of rows) map.set(row.id, { nodeType: row.node_type, refId: row.ref_id });
    }
    return map;
  }

  getEdgesForNodesBatch(
    nodeIds: number[],
  ): Array<EdgeRow & { edge_type_name: string; pivot_node_id: number }> {
    if (nodeIds.length === 0) return [];
    const nodeSet = new Set(nodeIds);
    const results: Array<EdgeRow & { edge_type_name: string; pivot_node_id: number }> = [];
    // Each chunk uses 2× placeholders (source IN + target IN), so use 450 per chunk
    const CHUNK = 450;
    for (let i = 0; i < nodeIds.length; i += CHUNK) {
      const chunk = nodeIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT e.*, et.name AS edge_type_name
           FROM edges e
           JOIN edge_types et ON e.edge_type_id = et.id
          WHERE e.source_node_id IN (${placeholders})
             OR e.target_node_id IN (${placeholders})`,
        )
        .all(...chunk, ...chunk) as (EdgeRow & { edge_type_name: string })[];

      for (const row of rows) {
        results.push({
          ...row,
          pivot_node_id: nodeSet.has(row.source_node_id) ? row.source_node_id : row.target_node_id,
        });
      }
    }
    return results;
  }

  getEdgeTypes(): EdgeTypeRow[] {
    return this.db
      .prepare(
        `SELECT name, category, COALESCE(description, '') as description FROM edge_types ORDER BY name`,
      )
      .all() as EdgeTypeRow[];
  }
}
