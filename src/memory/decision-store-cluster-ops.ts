/**
 * Decision-cluster persistence — extracted from `DecisionStore` (Task:
 * god-class decomposition). Owns the `decision_clusters` +
 * `decision_cluster_members` tables: create/update/delete a cluster, list
 * with filters, look up a decision's parent cluster(s), and count clusters
 * in a scope.
 *
 * `DecisionStore` holds one `ClusterOperations` instance and delegates its
 * public cluster methods to it verbatim — the public API and behavior are
 * unchanged, only the implementation moved.
 */

import type Database from 'better-sqlite3';
import type {
  DecisionType,
  DecisionRow,
  ClusterRow,
  ClusterInput,
  ClusterQuery,
} from './decision-types.js';

export class ClusterOperations {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a cluster + its membership rows in a single transaction.
   * `decision_count` is set from the input `decision_ids.length`.
   * Returns the inserted ClusterRow.
   */
  createCluster(input: ClusterInput): ClusterRow {
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const tagsJson = input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null;

    const insertCluster = this.db.prepare(
      `INSERT INTO decision_clusters
         (project_root, service_name, title, summary, tags, primary_type,
          decision_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMember = this.db.prepare(
      `INSERT OR IGNORE INTO decision_cluster_members (cluster_id, decision_id) VALUES (?, ?)`,
    );

    const tx = this.db.transaction(() => {
      const info = insertCluster.run(
        input.project_root,
        input.service_name ?? null,
        input.title,
        input.summary,
        tagsJson,
        input.primary_type ?? null,
        input.decision_ids.length,
        nowIso,
        nowMs,
      );
      const clusterId = info.lastInsertRowid as number;
      for (const id of input.decision_ids) insertMember.run(clusterId, id);
      return clusterId;
    });
    const id = tx();
    return this.getCluster(id)!;
  }

  /**
   * Update an existing cluster's title/summary/tags/primary_type and
   * replace its membership list. Used when `build_decision_clusters`
   * merges a freshly-computed cluster into an existing row.
   */
  updateCluster(
    id: number,
    input: {
      title?: string;
      summary?: string;
      tags?: string[];
      primary_type?: DecisionType | null;
      decision_ids?: number[];
    },
  ): ClusterRow | undefined {
    const existing = this.getCluster(id);
    if (!existing) return undefined;
    const nowMs = Date.now();
    const newTitle = input.title ?? existing.title;
    const newSummary = input.summary ?? existing.summary;
    const tagsJson =
      input.tags !== undefined
        ? input.tags.length > 0
          ? JSON.stringify(input.tags)
          : null
        : existing.tags;
    const newPrimaryType =
      input.primary_type !== undefined ? input.primary_type : existing.primary_type;
    const newCount = input.decision_ids ? input.decision_ids.length : existing.decision_count;

    const updateStmt = this.db.prepare(
      `UPDATE decision_clusters
         SET title = ?, summary = ?, tags = ?, primary_type = ?,
             decision_count = ?, updated_at = ?
       WHERE id = ?`,
    );
    const deleteMembers = this.db.prepare(
      `DELETE FROM decision_cluster_members WHERE cluster_id = ?`,
    );
    const insertMember = this.db.prepare(
      `INSERT OR IGNORE INTO decision_cluster_members (cluster_id, decision_id) VALUES (?, ?)`,
    );

    const tx = this.db.transaction(() => {
      updateStmt.run(newTitle, newSummary, tagsJson, newPrimaryType, newCount, nowMs, id);
      if (input.decision_ids) {
        deleteMembers.run(id);
        for (const did of input.decision_ids) insertMember.run(id, did);
      }
    });
    tx();
    return this.getCluster(id);
  }

  /** Single-cluster lookup by id. */
  getCluster(id: number): ClusterRow | undefined {
    const row = this.db.prepare('SELECT * FROM decision_clusters WHERE id = ?').get(id);
    return (row as ClusterRow) ?? undefined;
  }

  /**
   * List clusters with optional project/service/search filters.
   * Default ordering is by `decision_count DESC` (largest first) so the
   * wake-up "topics" surface lands the biggest topics on top.
   */
  listClusters(query: ClusterQuery = {}): ClusterRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.project_root) {
      conditions.push('project_root = ?');
      params.push(query.project_root);
    }
    if (query.service_name) {
      conditions.push('service_name = ?');
      params.push(query.service_name);
    }
    if (query.search) {
      conditions.push(
        'id IN (SELECT rowid FROM decision_clusters_fts WHERE decision_clusters_fts MATCH ?)',
      );
      params.push(query.search);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = query.order_by ?? 'decision_count';
    let orderClause: string;
    switch (orderBy) {
      case 'title':
        orderClause = 'ORDER BY title ASC';
        break;
      case 'updated_at':
        orderClause = 'ORDER BY updated_at DESC';
        break;
      case 'decision_count':
      default:
        orderClause = 'ORDER BY decision_count DESC, updated_at DESC';
    }

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    params.push(limit, offset);

    const sql = `SELECT * FROM decision_clusters ${where} ${orderClause} LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...params) as ClusterRow[];
  }

  /**
   * Get the member decisions of a cluster. Respects active-only by default
   * (matches `query_decisions` defaults). `include_invalidated` returns
   * the full historical membership.
   */
  getClusterDecisions(
    clusterId: number,
    opts: { limit?: number; include_invalidated?: boolean } = {},
  ): DecisionRow[] {
    const limit = opts.limit ?? 100;
    const activeOnly = !opts.include_invalidated;
    const where = activeOnly ? 'AND d.valid_until IS NULL' : '';
    const sql = `
      SELECT d.* FROM decisions d
        INNER JOIN decision_cluster_members m ON m.decision_id = d.id
       WHERE m.cluster_id = ? ${where}
       ORDER BY d.valid_from DESC
       LIMIT ?
    `;
    return this.db.prepare(sql).all(clusterId, limit) as DecisionRow[];
  }

  /**
   * Find all clusters a decision belongs to. Used by surfaces that want
   * to annotate a decision with its parent topic(s).
   */
  findClustersForDecision(decisionId: number): ClusterRow[] {
    const sql = `
      SELECT c.* FROM decision_clusters c
        INNER JOIN decision_cluster_members m ON m.cluster_id = c.id
       WHERE m.decision_id = ?
       ORDER BY c.decision_count DESC
    `;
    return this.db.prepare(sql).all(decisionId) as ClusterRow[];
  }

  /**
   * Delete a cluster. The `ON DELETE CASCADE` on
   * `decision_cluster_members.cluster_id` drops the membership rows
   * automatically. Returns true when a row was removed.
   */
  deleteCluster(id: number): boolean {
    const info = this.db.prepare('DELETE FROM decision_clusters WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /**
   * Drop every cluster (and cascade-drop their membership rows) for a
   * scope. Used by `build_decision_clusters` when `force=true` to start
   * from a clean slate. Returns the number of cluster rows removed.
   */
  deleteClustersForScope(opts: { project_root?: string; service_name?: string }): number {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.project_root) {
      conditions.push('project_root = ?');
      params.push(opts.project_root);
    }
    if (opts.service_name) {
      conditions.push('service_name = ?');
      params.push(opts.service_name);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const info = this.db.prepare(`DELETE FROM decision_clusters ${where}`).run(...params);
    return info.changes;
  }

  /** Count clusters in a scope (used by tests + stats). */
  countClusters(opts: { project_root?: string; service_name?: string } = {}): number {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.project_root) {
      conditions.push('project_root = ?');
      params.push(opts.project_root);
    }
    if (opts.service_name) {
      conditions.push('service_name = ?');
      params.push(opts.service_name);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM decision_clusters ${where}`)
      .get(...params) as { c: number };
    return row.c;
  }
}
