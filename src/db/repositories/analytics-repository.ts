import type Database from 'better-sqlite3';
import type { IndexStats, SymbolWithFilePath } from '../types.js';

export interface EnvVarRow {
  id: number;
  file_id: number;
  key: string;
  value_type: string;
  value_format: string | null;
  comment: string | null;
  quoted: number;
  line: number | null;
}

export interface WorkspaceStats {
  workspace: string;
  file_count: number;
  symbol_count: number;
  languages: string | null;
}

export interface CrossWorkspaceEdge {
  id: number;
  edge_type: string;
  source_workspace: string | null;
  source_path: string | null;
  source_symbol: string | null;
  source_kind: string | null;
  target_workspace: string | null;
  target_path: string | null;
  target_symbol: string | null;
  target_kind: string | null;
}

export interface WorkspaceDependency {
  from_workspace: string;
  to_workspace: string;
  edge_count: number;
  edge_types: string;
}

export interface GraphSnapshotRow {
  id: number;
  commit_hash: string | null;
  created_at: string;
  snapshot_type: string;
  file_path: string | null;
  data: string;
}

export class AnalyticsRepository {
  constructor(private readonly db: Database.Database) {}

  // --- Env vars ---

  insertEnvVar(
    fileId: number,
    entry: {
      key: string;
      valueType: string;
      valueFormat: string | null;
      comment: string | null;
      quoted: boolean;
      line: number;
    },
  ): number {
    return (
      this.db
        .prepare(
          `INSERT INTO env_vars (file_id, key, value_type, value_format, comment, quoted, line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fileId,
          entry.key,
          entry.valueType,
          entry.valueFormat,
          entry.comment,
          entry.quoted ? 1 : 0,
          entry.line,
        ) as { lastInsertRowid: number }
    ).lastInsertRowid as number;
  }

  deleteEnvVarsByFile(fileId: number): void {
    this.db.prepare('DELETE FROM env_vars WHERE file_id = ?').run(fileId);
  }

  getEnvVarsByFile(fileId: number): EnvVarRow[] {
    return this.db
      .prepare('SELECT * FROM env_vars WHERE file_id = ? ORDER BY line')
      .all(fileId) as EnvVarRow[];
  }

  getAllEnvVars(): (EnvVarRow & { file_path: string })[] {
    return this.db
      .prepare(
        `SELECT ev.*, f.path as file_path
       FROM env_vars ev
       JOIN files f ON ev.file_id = f.id
       ORDER BY f.path, ev.line`,
      )
      .all() as (EnvVarRow & { file_path: string })[];
  }

  searchEnvVars(pattern: string): (EnvVarRow & { file_path: string })[] {
    return this.db
      .prepare(
        `SELECT ev.*, f.path as file_path
       FROM env_vars ev
       JOIN files f ON ev.file_id = f.id
       WHERE ev.key LIKE ?
       ORDER BY f.path, ev.line`,
      )
      .all(`%${pattern}%`) as (EnvVarRow & { file_path: string })[];
  }

  // --- Workspace stats ---

  getWorkspaceStats(): WorkspaceStats[] {
    return this.db
      .prepare(`
      SELECT
        f.workspace,
        COUNT(DISTINCT f.id) as file_count,
        COUNT(DISTINCT s.id) as symbol_count,
        GROUP_CONCAT(DISTINCT f.language) as languages
      FROM files f
      LEFT JOIN symbols s ON s.file_id = f.id
      WHERE f.workspace IS NOT NULL
      GROUP BY f.workspace
      ORDER BY file_count DESC
    `)
      .all() as WorkspaceStats[];
  }

  getCrossWorkspaceEdges(): CrossWorkspaceEdge[] {
    return this.db
      .prepare(`
      SELECT
        e.id,
        et.name as edge_type,
        sf.workspace as source_workspace,
        sf.path as source_path,
        ss.name as source_symbol,
        ss.kind as source_kind,
        tf.workspace as target_workspace,
        tf.path as target_path,
        ts.name as target_symbol,
        ts.kind as target_kind
      FROM edges e
      JOIN edge_types et ON e.edge_type_id = et.id
      JOIN nodes sn ON e.source_node_id = sn.id
      JOIN nodes tn ON e.target_node_id = tn.id
      LEFT JOIN symbols ss ON sn.node_type = 'symbol' AND sn.ref_id = ss.id
      LEFT JOIN files sf ON (sn.node_type = 'file' AND sn.ref_id = sf.id) OR ss.file_id = sf.id
      LEFT JOIN symbols ts ON tn.node_type = 'symbol' AND tn.ref_id = ts.id
      LEFT JOIN files tf ON (tn.node_type = 'file' AND tn.ref_id = tf.id) OR ts.file_id = tf.id
      WHERE e.is_cross_ws = 1
      ORDER BY sf.workspace, tf.workspace
    `)
      .all() as CrossWorkspaceEdge[];
  }

  getWorkspaceDependencyGraph(): WorkspaceDependency[] {
    return this.db
      .prepare(`
      SELECT
        sf.workspace as from_workspace,
        tf.workspace as to_workspace,
        COUNT(*) as edge_count,
        GROUP_CONCAT(DISTINCT et.name) as edge_types
      FROM edges e
      JOIN edge_types et ON e.edge_type_id = et.id
      JOIN nodes sn ON e.source_node_id = sn.id
      JOIN nodes tn ON e.target_node_id = tn.id
      LEFT JOIN symbols ss ON sn.node_type = 'symbol' AND sn.ref_id = ss.id
      LEFT JOIN files sf ON (sn.node_type = 'file' AND sn.ref_id = sf.id) OR ss.file_id = sf.id
      LEFT JOIN symbols ts ON tn.node_type = 'symbol' AND tn.ref_id = ts.id
      LEFT JOIN files tf ON (tn.node_type = 'file' AND tn.ref_id = tf.id) OR ts.file_id = tf.id
      WHERE e.is_cross_ws = 1
        AND sf.workspace IS NOT NULL
        AND tf.workspace IS NOT NULL
        AND sf.workspace != tf.workspace
      GROUP BY sf.workspace, tf.workspace
      ORDER BY edge_count DESC
    `)
      .all() as WorkspaceDependency[];
  }

  getWorkspaceExports(workspace: string): SymbolWithFilePath[] {
    return this.db
      .prepare(`
      SELECT DISTINCT s.*, f.path as file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN nodes n ON n.node_type = 'symbol' AND n.ref_id = s.id
      JOIN edges e ON e.target_node_id = n.id AND e.is_cross_ws = 1
      WHERE f.workspace = ?
      ORDER BY s.kind, s.name
    `)
      .all(workspace) as SymbolWithFilePath[];
  }

  // --- Index stats ---

  getStats(): IndexStats {
    const fileCount = (this.db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
    const symbolCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }
    ).c;
    const edgeCount = (this.db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
    const nodeCount = (this.db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    const routeCount = (this.db.prepare('SELECT COUNT(*) as c FROM routes').get() as { c: number })
      .c;
    const componentCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM components').get() as { c: number }
    ).c;
    const migrationCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number }
    ).c;

    const partialFiles = (
      this.db.prepare("SELECT COUNT(*) as c FROM files WHERE status = 'partial'").get() as {
        c: number;
      }
    ).c;
    const errorFiles = (
      this.db.prepare("SELECT COUNT(*) as c FROM files WHERE status = 'error'").get() as {
        c: number;
      }
    ).c;

    return {
      totalFiles: fileCount,
      totalSymbols: symbolCount,
      totalEdges: edgeCount,
      totalNodes: nodeCount,
      totalRoutes: routeCount,
      totalComponents: componentCount,
      totalMigrations: migrationCount,
      partialFiles,
      errorFiles,
    };
  }

  // --- Graph Snapshots ---

  insertGraphSnapshot(
    snapshotType: string,
    data: Record<string, unknown>,
    commitHash?: string,
    filePath?: string,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO graph_snapshots (commit_hash, snapshot_type, file_path, data)
       VALUES (?, ?, ?, ?)`,
      )
      .run(commitHash ?? null, snapshotType, filePath ?? null, JSON.stringify(data));
    return Number(result.lastInsertRowid);
  }

  getGraphSnapshots(
    snapshotType: string,
    options: { filePath?: string; since?: string; limit?: number } = {},
  ): GraphSnapshotRow[] {
    const conditions = ['snapshot_type = ?'];
    const params: unknown[] = [snapshotType];
    if (options.filePath) {
      conditions.push('file_path = ?');
      params.push(options.filePath);
    }
    if (options.since) {
      conditions.push('created_at >= ?');
      params.push(options.since);
    }
    params.push(options.limit ?? 50);
    return this.db
      .prepare(`
      SELECT * FROM graph_snapshots
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT ?
    `)
      .all(...params) as GraphSnapshotRow[];
  }

  pruneGraphSnapshots(maxAge: number = 90): number {
    const result = this.db
      .prepare(
        `DELETE FROM graph_snapshots WHERE created_at < datetime('now', '-' || ? || ' days')`,
      )
      .run(maxAge);
    return result.changes;
  }
}
