import type Database from 'better-sqlite3';
import type { RawSymbol, RawEdge, RawRoute, RawComponent, RawMigration, RawOrmModel, RawOrmAssociation, RawRnScreen } from '../plugin-api/types.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { dbError } from '../errors.js';

export class Store {
  constructor(public readonly db: Database.Database) {}

  // --- Files ---

  insertFile(
    path: string,
    language: string | null,
    contentHash: string | null,
    byteLength: number | null,
    workspace?: string | null,
  ): number {
    const result = this.db.prepare(
      `INSERT INTO files (path, language, content_hash, byte_length, indexed_at, workspace)
       VALUES (?, ?, ?, ?, datetime('now'), ?)`,
    ).run(path, language, contentHash, byteLength, workspace ?? null);
    const fileId = Number(result.lastInsertRowid);

    // Create node in unified address space
    this.createNode('file', fileId);
    return fileId;
  }

  getFile(path: string): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined;
  }

  getFileById(id: number): FileRow | undefined {
    return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
  }

  getAllFiles(): FileRow[] {
    return this.db.prepare('SELECT * FROM files').all() as FileRow[];
  }

  updateFileWorkspace(fileId: number, workspace: string): void {
    this.db.prepare('UPDATE files SET workspace = ? WHERE id = ?').run(workspace, fileId);
  }

  getFilesByWorkspace(workspace: string): FileRow[] {
    return this.db.prepare('SELECT * FROM files WHERE workspace = ?').all(workspace) as FileRow[];
  }

  updateFileHash(fileId: number, hash: string, byteLength: number): void {
    this.db.prepare(
      "UPDATE files SET content_hash = ?, byte_length = ?, indexed_at = datetime('now') WHERE id = ?",
    ).run(hash, byteLength, fileId);
  }

  updateFileStatus(fileId: number, status: string, frameworkRole?: string): void {
    this.db.prepare(
      'UPDATE files SET status = ?, framework_role = COALESCE(?, framework_role) WHERE id = ?',
    ).run(status, frameworkRole ?? null, fileId);
  }

  deleteFile(fileId: number): void {
    // Cascade deletes symbols, edges via nodes
    this.deleteEdgesForFileNodes(fileId);
    this.db.prepare('DELETE FROM nodes WHERE node_type = ? AND ref_id = ?').run('file', fileId);
    this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  }

  // --- Symbols ---

  insertSymbol(fileId: number, sym: RawSymbol): number {
    const parentId = sym.parentSymbolId
      ? (this.db.prepare('SELECT id FROM symbols WHERE symbol_id = ?').get(sym.parentSymbolId) as { id: number } | undefined)?.id ?? null
      : null;

    const result = this.db.prepare(
      `INSERT OR REPLACE INTO symbols (file_id, symbol_id, name, kind, fqn, parent_id, signature, byte_start, byte_end, line_start, line_end, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fileId,
      sym.symbolId,
      sym.name,
      sym.kind,
      sym.fqn ?? null,
      parentId,
      sym.signature ?? null,
      sym.byteStart,
      sym.byteEnd,
      sym.lineStart ?? null,
      sym.lineEnd ?? null,
      sym.metadata ? JSON.stringify(sym.metadata) : null,
    );

    const symbolId = Number(result.lastInsertRowid);
    this.createNode('symbol', symbolId);
    return symbolId;
  }

  insertSymbols(fileId: number, symbols: RawSymbol[]): number[] {
    return this.db.transaction(() => {
      return symbols.map((s) => this.insertSymbol(fileId, s));
    })();
  }

  deleteSymbolsByFile(fileId: number): void {
    const symbols = this.db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(fileId) as { id: number }[];
    for (const sym of symbols) {
      this.db.prepare('DELETE FROM nodes WHERE node_type = ? AND ref_id = ?').run('symbol', sym.id);
    }
    this.db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
  }

  getSymbolsByFile(fileId: number): SymbolRow[] {
    return this.db.prepare('SELECT * FROM symbols WHERE file_id = ? ORDER BY byte_start').all(fileId) as SymbolRow[];
  }

  getSymbolBySymbolId(symbolId: string): SymbolRow | undefined {
    return this.db.prepare('SELECT * FROM symbols WHERE symbol_id = ?').get(symbolId) as SymbolRow | undefined;
  }

  getSymbolByFqn(fqn: string): SymbolRow | undefined {
    return this.db.prepare('SELECT * FROM symbols WHERE fqn = ?').get(fqn) as SymbolRow | undefined;
  }

  // --- Nodes ---

  createNode(nodeType: string, refId: number): number {
    const existing = this.db.prepare(
      'SELECT id FROM nodes WHERE node_type = ? AND ref_id = ?',
    ).get(nodeType, refId) as { id: number } | undefined;

    if (existing) return existing.id;

    const result = this.db.prepare(
      'INSERT INTO nodes (node_type, ref_id) VALUES (?, ?)',
    ).run(nodeType, refId);
    return Number(result.lastInsertRowid);
  }

  getNodeId(nodeType: string, refId: number): number | undefined {
    const row = this.db.prepare(
      'SELECT id FROM nodes WHERE node_type = ? AND ref_id = ?',
    ).get(nodeType, refId) as { id: number } | undefined;
    return row?.id;
  }

  // --- Edges ---

  insertEdge(
    sourceNodeId: number,
    targetNodeId: number,
    edgeTypeName: string,
    resolved = true,
    metadata?: Record<string, unknown>,
    isCrossWs = false,
  ): TraceMcpResult<number> {
    const edgeType = this.db.prepare('SELECT id FROM edge_types WHERE name = ?').get(edgeTypeName) as { id: number } | undefined;
    if (!edgeType) {
      return err(dbError(`Unknown edge type: ${edgeTypeName}`));
    }

    try {
      const result = this.db.prepare(
        `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(sourceNodeId, targetNodeId, edgeType.id, resolved ? 1 : 0, metadata ? JSON.stringify(metadata) : null, isCrossWs ? 1 : 0);
      return ok(Number(result.lastInsertRowid));
    } catch (e) {
      return err(dbError(e instanceof Error ? e.message : String(e)));
    }
  }

  deleteEdgesForFileNodes(fileId: number): void {
    // Delete edges where source or target is a node belonging to this file
    const symbolIds = this.db.prepare('SELECT id FROM symbols WHERE file_id = ?').all(fileId) as { id: number }[];
    const nodeIds: number[] = [];

    const fileNodeId = this.getNodeId('file', fileId);
    if (fileNodeId) nodeIds.push(fileNodeId);

    for (const sym of symbolIds) {
      const nid = this.getNodeId('symbol', sym.id);
      if (nid) nodeIds.push(nid);
    }

    if (nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM edges WHERE source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders})`).run(...nodeIds, ...nodeIds);
    }
  }

  // --- Graph Traversal ---

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

  // --- Routes ---

  insertRoute(route: RawRoute, fileId: number): number {
    // controller_symbol_id is an INTEGER FK to symbols.id
    // If controllerSymbolId is a string FQN ref, we store null for the FK
    // and encode it in the middleware JSON as { middleware: [...], controllerRef: "..." }
    let resolvedControllerSymId: number | null = null;
    let controllerRef: string | undefined;

    if (route.controllerSymbolId) {
      const asNum = Number(route.controllerSymbolId);
      if (!isNaN(asNum)) {
        resolvedControllerSymId = asNum;
      } else {
        controllerRef = route.controllerSymbolId;
      }
    }

    // Encode middleware + optional controllerRef together
    const mwArray = route.middleware ?? [];
    let middlewareJson: string | null = null;
    if (controllerRef || mwArray.length > 0) {
      middlewareJson = JSON.stringify({
        middleware: mwArray,
        ...(controllerRef ? { controllerRef } : {}),
      });
    }

    const result = this.db.prepare(
      `INSERT INTO routes (method, uri, name, controller_symbol_id, middleware, file_id, line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      route.method,
      route.uri,
      route.name ?? null,
      resolvedControllerSymId,
      middlewareJson,
      fileId,
      route.line ?? null,
    );
    const routeId = Number(result.lastInsertRowid);
    this.createNode('route', routeId);
    return routeId;
  }

  // --- Components ---

  insertComponent(comp: RawComponent, fileId: number): number {
    const result = this.db.prepare(
      `INSERT INTO components (file_id, name, kind, props, emits, slots, composables, framework)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fileId,
      comp.name,
      comp.kind,
      comp.props ? JSON.stringify(comp.props) : null,
      comp.emits ? JSON.stringify(comp.emits) : null,
      comp.slots ? JSON.stringify(comp.slots) : null,
      comp.composables ? JSON.stringify(comp.composables) : null,
      comp.framework,
    );
    const compId = Number(result.lastInsertRowid);
    this.createNode('component', compId);
    return compId;
  }

  getComponentByFileId(fileId: number): ComponentRow | undefined {
    return this.db.prepare('SELECT * FROM components WHERE file_id = ?').get(fileId) as ComponentRow | undefined;
  }

  getComponentByName(name: string): ComponentRow | undefined {
    return this.db.prepare('SELECT * FROM components WHERE name = ?').get(name) as ComponentRow | undefined;
  }

  getAllComponents(): ComponentRow[] {
    return this.db.prepare('SELECT * FROM components').all() as ComponentRow[];
  }

  /** Ensure an edge type exists in the database, inserting if missing. */
  ensureEdgeType(name: string, category: string, description: string): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO edge_types (name, category, directed, description) VALUES (?, ?, 1, ?)',
    ).run(name, category, description);
  }

  /** Get the edge type name by its id */
  getEdgeTypeName(edgeTypeId: number): string | undefined {
    const row = this.db.prepare('SELECT name FROM edge_types WHERE id = ?').get(edgeTypeId) as { name: string } | undefined;
    return row?.name;
  }

  /** Reverse-lookup: find which symbol/file a node refers to */
  getNodeRef(nodeId: number): { nodeType: string; refId: number } | undefined {
    return this.db.prepare('SELECT node_type AS nodeType, ref_id AS refId FROM nodes WHERE id = ?').get(nodeId) as { nodeType: string; refId: number } | undefined;
  }

  // --- Migrations ---

  insertMigration(mig: RawMigration, fileId: number): number {
    const result = this.db.prepare(
      `INSERT INTO migrations (file_id, table_name, operation, columns, indices, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      fileId,
      mig.tableName,
      mig.operation,
      mig.columns ? JSON.stringify(mig.columns) : null,
      mig.indices ? JSON.stringify(mig.indices) : null,
      mig.timestamp ?? null,
    );
    const migId = Number(result.lastInsertRowid);
    this.createNode('migration', migId);
    return migId;
  }

  // --- Route queries ---

  getRouteByUriAndMethod(uri: string, method: string): RouteRow | undefined {
    return this.db.prepare(
      'SELECT * FROM routes WHERE uri = ? AND method = ?',
    ).get(uri, method) as RouteRow | undefined;
  }

  getAllRoutes(): RouteRow[] {
    return this.db.prepare('SELECT * FROM routes').all() as RouteRow[];
  }

  findRouteByPattern(uri: string, method: string): RouteRow | undefined {
    const likePattern = uri.replace(/\{[^}]+\}/g, '%');
    const routes = this.db.prepare(
      'SELECT * FROM routes WHERE method = ? AND uri LIKE ?',
    ).all(method.toUpperCase(), likePattern) as RouteRow[];
    const exact = routes.find((r) => r.uri === uri);
    return exact ?? routes[0];
  }

  // --- Migration queries ---

  getMigrationsByTable(tableName: string): MigrationRow[] {
    return this.db.prepare(
      'SELECT * FROM migrations WHERE table_name = ? ORDER BY timestamp ASC',
    ).all(tableName) as MigrationRow[];
  }

  getAllMigrations(): MigrationRow[] {
    return this.db.prepare(
      'SELECT * FROM migrations ORDER BY timestamp ASC',
    ).all() as MigrationRow[];
  }

  // --- Edge queries ---

  getEdgesByType(edgeTypeName: string): EdgeRow[] {
    const edgeType = this.db.prepare(
      'SELECT id FROM edge_types WHERE name = ?',
    ).get(edgeTypeName) as { id: number } | undefined;
    if (!edgeType) return [];
    return this.db.prepare(
      'SELECT * FROM edges WHERE edge_type_id = ?',
    ).all(edgeType.id) as EdgeRow[];
  }

  getOutgoingEdges(nodeId: number): (EdgeRow & { edge_type_name: string })[] {
    return this.db.prepare(
      `SELECT e.*, et.name as edge_type_name
       FROM edges e JOIN edge_types et ON e.edge_type_id = et.id
       WHERE e.source_node_id = ?`,
    ).all(nodeId) as (EdgeRow & { edge_type_name: string })[];
  }

  getIncomingEdges(nodeId: number): (EdgeRow & { edge_type_name: string })[] {
    return this.db.prepare(
      `SELECT e.*, et.name as edge_type_name
       FROM edges e JOIN edge_types et ON e.edge_type_id = et.id
       WHERE e.target_node_id = ?`,
    ).all(nodeId) as (EdgeRow & { edge_type_name: string })[];
  }

  // --- ORM Models ---

  insertOrmModel(model: RawOrmModel, fileId: number): number {
    const result = this.db.prepare(
      `INSERT INTO orm_models (file_id, name, orm, collection_or_table, fields, options, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fileId,
      model.name,
      model.orm,
      model.collectionOrTable ?? null,
      model.fields ? JSON.stringify(model.fields) : null,
      model.options ? JSON.stringify(model.options) : null,
      model.metadata ? JSON.stringify(model.metadata) : null,
    );
    const modelId = Number(result.lastInsertRowid);
    this.createNode('orm_model', modelId);
    return modelId;
  }

  getOrmModelByName(name: string): OrmModelRow | undefined {
    return this.db.prepare('SELECT * FROM orm_models WHERE name = ?').get(name) as OrmModelRow | undefined;
  }

  getOrmModelsByOrm(orm: string): OrmModelRow[] {
    return this.db.prepare('SELECT * FROM orm_models WHERE orm = ?').all(orm) as OrmModelRow[];
  }

  getAllOrmModels(): OrmModelRow[] {
    return this.db.prepare('SELECT * FROM orm_models').all() as OrmModelRow[];
  }

  // --- ORM Associations ---

  insertOrmAssociation(
    sourceModelId: number,
    targetModelId: number | null,
    targetModelName: string,
    kind: string,
    options?: Record<string, unknown>,
    fileId?: number,
    line?: number,
  ): number {
    const result = this.db.prepare(
      `INSERT INTO orm_associations (source_model_id, target_model_id, target_model_name, kind, options, file_id, line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sourceModelId,
      targetModelId,
      targetModelName,
      kind,
      options ? JSON.stringify(options) : null,
      fileId ?? null,
      line ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  getOrmAssociationsByModel(modelId: number): OrmAssociationRow[] {
    return this.db.prepare(
      'SELECT * FROM orm_associations WHERE source_model_id = ?',
    ).all(modelId) as OrmAssociationRow[];
  }

  // --- React Native Screens ---

  insertRnScreen(screen: RawRnScreen, fileId: number): number {
    const result = this.db.prepare(
      `INSERT INTO rn_screens (file_id, name, component_path, navigator_type, options, deep_link, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fileId,
      screen.name,
      screen.componentPath ?? null,
      screen.navigatorType ?? null,
      screen.options ? JSON.stringify(screen.options) : null,
      screen.deepLink ?? null,
      screen.metadata ? JSON.stringify(screen.metadata) : null,
    );
    const screenId = Number(result.lastInsertRowid);
    this.createNode('rn_screen', screenId);
    return screenId;
  }

  getRnScreenByName(name: string): RnScreenRow | undefined {
    return this.db.prepare('SELECT * FROM rn_screens WHERE name = ?').get(name) as RnScreenRow | undefined;
  }

  getAllRnScreens(): RnScreenRow[] {
    return this.db.prepare('SELECT * FROM rn_screens').all() as RnScreenRow[];
  }

  getSymbolById(id: number): SymbolRow | undefined {
    return this.db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as SymbolRow | undefined;
  }

  getNodeByNodeId(nodeId: number): { node_type: string; ref_id: number } | undefined {
    return this.db.prepare(
      'SELECT node_type, ref_id FROM nodes WHERE id = ?',
    ).get(nodeId) as { node_type: string; ref_id: number } | undefined;
  }

  // --- Stats ---

  getStats(): IndexStats {
    const fileCount = (this.db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number }).c;
    const symbolCount = (this.db.prepare('SELECT COUNT(*) as c FROM symbols').get() as { c: number }).c;
    const edgeCount = (this.db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
    const nodeCount = (this.db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    const routeCount = (this.db.prepare('SELECT COUNT(*) as c FROM routes').get() as { c: number }).c;
    const componentCount = (this.db.prepare('SELECT COUNT(*) as c FROM components').get() as { c: number }).c;
    const migrationCount = (this.db.prepare('SELECT COUNT(*) as c FROM migrations').get() as { c: number }).c;

    const partialFiles = (this.db.prepare("SELECT COUNT(*) as c FROM files WHERE status = 'partial'").get() as { c: number }).c;
    const errorFiles = (this.db.prepare("SELECT COUNT(*) as c FROM files WHERE status = 'error'").get() as { c: number }).c;

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
}

// --- Row types ---

export interface FileRow {
  id: number;
  path: string;
  language: string | null;
  framework_role: string | null;
  status: string;
  content_hash: string | null;
  byte_length: number | null;
  indexed_at: string;
  metadata: string | null;
  workspace: string | null;
}

export interface SymbolRow {
  id: number;
  file_id: number;
  symbol_id: string;
  name: string;
  kind: string;
  fqn: string | null;
  parent_id: number | null;
  signature: string | null;
  summary: string | null;
  byte_start: number;
  byte_end: number;
  line_start: number | null;
  line_end: number | null;
  metadata: string | null;
}

export interface EdgeRow {
  id: number;
  source_node_id: number;
  target_node_id: number;
  edge_type_id: number;
  resolved: number;
  metadata: string | null;
  is_cross_ws: number;
}

export interface RouteRow {
  id: number;
  method: string;
  uri: string;
  name: string | null;
  controller_symbol_id: string | null;
  middleware: string | null;
  file_id: number | null;
  line: number | null;
}

export interface MigrationRow {
  id: number;
  file_id: number;
  table_name: string;
  operation: string;
  columns: string | null;
  indices: string | null;
  timestamp: string | null;
}

export interface ComponentRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  props: string | null;
  emits: string | null;
  slots: string | null;
  composables: string | null;
  framework: string;
}

export interface OrmModelRow {
  id: number;
  file_id: number;
  name: string;
  orm: string;
  collection_or_table: string | null;
  fields: string | null;
  options: string | null;
  metadata: string | null;
}

export interface OrmAssociationRow {
  id: number;
  source_model_id: number;
  target_model_id: number | null;
  target_model_name: string | null;
  kind: string;
  options: string | null;
  file_id: number | null;
  line: number | null;
}

export interface RnScreenRow {
  id: number;
  file_id: number;
  name: string;
  component_path: string | null;
  navigator_type: string | null;
  options: string | null;
  deep_link: string | null;
  metadata: string | null;
}

export interface IndexStats {
  totalFiles: number;
  totalSymbols: number;
  totalEdges: number;
  totalNodes: number;
  totalRoutes: number;
  totalComponents: number;
  totalMigrations: number;
  partialFiles: number;
  errorFiles: number;
}
