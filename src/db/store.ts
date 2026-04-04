import type Database from 'better-sqlite3';
import type { RawSymbol, RawEdge, RawRoute, RawComponent, RawMigration, RawOrmModel, RawOrmAssociation, RawRnScreen } from '../plugin-api/types.js';
import { ok, err, type TraceMcpResult } from '../errors.js';
import { dbError } from '../errors.js';

export class Store {
  constructor(public readonly db: Database.Database) {
    // Pre-compile hot-path prepared statements to avoid per-call allocation overhead.
    // better-sqlite3 caches the native side, but the JS wrapper creation is measurable at 10K+ calls.
    this._stmts = {
      getFile: db.prepare('SELECT * FROM files WHERE path = ?'),
      getFileById: db.prepare('SELECT * FROM files WHERE id = ?'),
      getNodeId: db.prepare('SELECT id FROM nodes WHERE node_type = ? AND ref_id = ?'),
      createNodeInsert: db.prepare('INSERT OR IGNORE INTO nodes (node_type, ref_id) VALUES (?, ?)'),
      createNodeSelect: db.prepare('SELECT id FROM nodes WHERE node_type = ? AND ref_id = ?'),
      getNodeRef: db.prepare('SELECT node_type AS nodeType, ref_id AS refId FROM nodes WHERE id = ?'),
      getEdgeType: db.prepare('SELECT id FROM edge_types WHERE name = ?'),
      insertEdge: db.prepare(
        `INSERT OR IGNORE INTO edges (source_node_id, target_node_id, edge_type_id, resolved, metadata, is_cross_ws)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      insertSymbol: db.prepare(
        `INSERT OR REPLACE INTO symbols (file_id, symbol_id, name, kind, fqn, parent_id, signature, byte_start, byte_end, line_start, line_end, metadata, cyclomatic, max_nesting, param_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getSymbolById: db.prepare('SELECT * FROM symbols WHERE id = ?'),
    };
  }

  private readonly _stmts: {
    getFile: Database.Statement;
    getFileById: Database.Statement;
    getNodeId: Database.Statement;
    createNodeInsert: Database.Statement;
    createNodeSelect: Database.Statement;
    getNodeRef: Database.Statement;
    getEdgeType: Database.Statement;
    insertEdge: Database.Statement;
    insertSymbol: Database.Statement;
    getSymbolById: Database.Statement;
  };

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
    return this._stmts.getFile.get(path) as FileRow | undefined;
  }

  getFileById(id: number): FileRow | undefined {
    return this._stmts.getFileById.get(id) as FileRow | undefined;
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

  updateFileGitignored(fileId: number, gitignored: boolean): void {
    this.db.prepare('UPDATE files SET gitignored = ? WHERE id = ?').run(gitignored ? 1 : 0, fileId);
  }

  deleteFile(fileId: number): void {
    // Cascade deletes symbols, edges via nodes
    this.deleteEdgesForFileNodes(fileId);
    this.deleteEntitiesByFile(fileId);
    this.db.prepare('DELETE FROM nodes WHERE node_type = ? AND ref_id = ?').run('file', fileId);
    this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  }

  /** Delete routes, components, migrations, ORM models, and RN screens for a file (and their nodes). */
  deleteEntitiesByFile(fileId: number): void {
    // Use subquery DELETEs — avoids SELECT + placeholder building per table.
    for (const [table, nodeType] of [
      ['routes', 'route'],
      ['components', 'component'],
      ['migrations', 'migration'],
      ['orm_models', 'orm_model'],
      ['rn_screens', 'rn_screen'],
    ] as const) {
      this.db.prepare(
        `DELETE FROM nodes WHERE node_type = ? AND ref_id IN (SELECT id FROM ${table} WHERE file_id = ?)`,
      ).run(nodeType, fileId);
      this.db.prepare(`DELETE FROM ${table} WHERE file_id = ?`).run(fileId);
    }
  }

  // --- Symbols ---

  insertSymbol(fileId: number, sym: RawSymbol, parentIdOverride?: number | null): number {
    const parentId = parentIdOverride !== undefined
      ? parentIdOverride
      : sym.parentSymbolId
        ? (this.db.prepare('SELECT id FROM symbols WHERE symbol_id = ?').get(sym.parentSymbolId) as { id: number } | undefined)?.id ?? null
        : null;

    // Extract complexity metrics from metadata (computed in pipeline)
    const cyclomatic = (sym.metadata as Record<string, unknown> | undefined)?.['cyclomatic'] as number | undefined ?? null;
    const maxNesting = (sym.metadata as Record<string, unknown> | undefined)?.['max_nesting'] as number | undefined ?? null;
    const paramCount = (sym.metadata as Record<string, unknown> | undefined)?.['param_count'] as number | undefined ?? null;

    const result = this._stmts.insertSymbol.run(
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
      cyclomatic,
      maxNesting,
      paramCount,
    );

    const symbolId = Number(result.lastInsertRowid);
    this.createNode('symbol', symbolId);
    return symbolId;
  }

  insertSymbols(fileId: number, symbols: RawSymbol[]): number[] {
    return this.db.transaction(() => {
      // Batch-resolve parent symbol IDs to avoid N+1 SELECTs.
      // Parents can be: (a) already in DB from a previous file, or
      // (b) in the current batch (same file, inserted earlier in loop).
      const parentSymbolIds = symbols
        .map((s) => s.parentSymbolId)
        .filter((id): id is string => id != null);

      const parentIdMap = new Map<string, number>();
      if (parentSymbolIds.length > 0) {
        const unique = [...new Set(parentSymbolIds)];
        const placeholders = unique.map(() => '?').join(',');
        const rows = this.db.prepare(
          `SELECT symbol_id, id FROM symbols WHERE symbol_id IN (${placeholders})`,
        ).all(...unique) as { symbol_id: string; id: number }[];
        for (const row of rows) parentIdMap.set(row.symbol_id, row.id);
      }

      const ids: number[] = [];
      for (const sym of symbols) {
        // Resolve parent: check batch-loaded map, then check already-inserted
        // symbols in this batch (parent defined earlier in same file).
        let parentId: number | null = null;
        if (sym.parentSymbolId) {
          parentId = parentIdMap.get(sym.parentSymbolId) ?? null;
          // Parent might have been inserted earlier in this loop
          if (parentId == null) {
            const idx = symbols.findIndex((s) => s.symbolId === sym.parentSymbolId);
            if (idx >= 0 && idx < ids.length) {
              parentId = ids[idx];
            }
          }
        }
        const id = this.insertSymbol(fileId, sym, parentId);
        ids.push(id);
        // Track newly inserted symbol so later siblings can find it
        parentIdMap.set(sym.symbolId, id);
      }
      return ids;
    })();
  }

  deleteSymbolsByFile(fileId: number): void {
    // Single subquery instead of N individual per-symbol DELETEs
    this.db.prepare(
      `DELETE FROM nodes WHERE node_type = 'symbol'
         AND ref_id IN (SELECT id FROM symbols WHERE file_id = ?)`,
    ).run(fileId);
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
    this._stmts.createNodeInsert.run(nodeType, refId);
    return (this._stmts.createNodeSelect.get(nodeType, refId) as { id: number }).id;
  }

  getNodeId(nodeType: string, refId: number): number | undefined {
    return (this._stmts.getNodeId.get(nodeType, refId) as { id: number } | undefined)?.id;
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
    const edgeType = this._stmts.getEdgeType.get(edgeTypeName) as { id: number } | undefined;
    if (!edgeType) {
      return err(dbError(`Unknown edge type: ${edgeTypeName}`));
    }

    try {
      const result = this._stmts.insertEdge.run(
        sourceNodeId, targetNodeId, edgeType.id,
        resolved ? 1 : 0, metadata ? JSON.stringify(metadata) : null, isCrossWs ? 1 : 0,
      );
      return ok(Number(result.lastInsertRowid));
    } catch (e) {
      return err(dbError(e instanceof Error ? e.message : String(e)));
    }
  }

  deleteEdgesForFileNodes(fileId: number): void {
    // Collect all node IDs for this file's symbols + file node in a single subquery
    this.db.prepare(`
      DELETE FROM edges WHERE source_node_id IN (
        SELECT n.id FROM nodes n
        WHERE (n.node_type = 'file' AND n.ref_id = ?)
           OR (n.node_type = 'symbol' AND n.ref_id IN (SELECT id FROM symbols WHERE file_id = ?))
      ) OR target_node_id IN (
        SELECT n.id FROM nodes n
        WHERE (n.node_type = 'file' AND n.ref_id = ?)
           OR (n.node_type = 'symbol' AND n.ref_id IN (SELECT id FROM symbols WHERE file_id = ?))
      )
    `).run(fileId, fileId, fileId, fileId);
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
    return this._stmts.getNodeRef.get(nodeId) as { nodeType: string; refId: number } | undefined;
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

  getAllOrmAssociations(): OrmAssociationRow[] {
    return this.db.prepare('SELECT * FROM orm_associations').all() as OrmAssociationRow[];
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
    return this._stmts.getSymbolById.get(id) as SymbolRow | undefined;
  }

  getNodeByNodeId(nodeId: number): { node_type: string; ref_id: number } | undefined {
    return this.db.prepare(
      'SELECT node_type, ref_id FROM nodes WHERE id = ?',
    ).get(nodeId) as { node_type: string; ref_id: number } | undefined;
  }

  // --- Introspection queries ---

  findImplementors(name: string): SymbolWithFilePath[] {
    return this.db.prepare(
      `SELECT s.*, f.path as file_path
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE s.metadata IS NOT NULL AND (
         json_extract(s.metadata, '$.implements') LIKE '%"' || ? || '"%'
         OR json_extract(s.metadata, '$.extends') LIKE '%"' || ? || '"%'
         OR json_extract(s.metadata, '$.extends') = ?
       )`,
    ).all(name, name, name) as SymbolWithFilePath[];
  }

  getExportedSymbols(filePattern?: string): SymbolWithFilePath[] {
    if (filePattern) {
      const likePattern = filePattern.replace(/\*/g, '%').replace(/\?/g, '_');
      return this.db.prepare(
        `SELECT s.*, f.path as file_path
         FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE json_extract(s.metadata, '$.exported') = 1
         AND f.path LIKE ?`,
      ).all(likePattern) as SymbolWithFilePath[];
    }
    return this.db.prepare(
      `SELECT s.*, f.path as file_path
       FROM symbols s
       JOIN files f ON s.file_id = f.id
       WHERE json_extract(s.metadata, '$.exported') = 1`,
    ).all() as SymbolWithFilePath[];
  }

  getEdgeTypes(): EdgeTypeRow[] {
    return this.db.prepare(
      `SELECT name, category, COALESCE(description, '') as description FROM edge_types ORDER BY name`,
    ).all() as EdgeTypeRow[];
  }

  /**
   * Get all symbols that have heritage metadata (extends/implements).
   * Used by the TypeScript heritage resolver in the pipeline.
   */
  getSymbolsWithHeritage(): (SymbolRow & { file_path: string })[] {
    return this.db.prepare(`
      SELECT s.*, f.path AS file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.metadata IS NOT NULL
        AND (json_extract(s.metadata, '$.extends') IS NOT NULL
          OR json_extract(s.metadata, '$.implements') IS NOT NULL)
    `).all() as (SymbolRow & { file_path: string })[];
  }

  /**
   * Find a symbol by name and optional kind.
   * Returns the first match (prefers exact name match over substring).
   */
  getSymbolByName(name: string, kind?: string): SymbolRow | undefined {
    if (kind) {
      return this.db.prepare(
        'SELECT * FROM symbols WHERE name = ? AND kind = ? LIMIT 1',
      ).get(name, kind) as SymbolRow | undefined;
    }
    return this.db.prepare(
      'SELECT * FROM symbols WHERE name = ? LIMIT 1',
    ).get(name) as SymbolRow | undefined;
  }

  // --- Batch queries (avoid N+1) ---

  /** Resolve multiple node IDs in one query. Returns Map<refId, nodeId>. */
  getNodeIdsBatch(nodeType: string, refIds: number[]): Map<number, number> {
    const map = new Map<number, number>();
    if (refIds.length === 0) return map;
    const placeholders = refIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT ref_id, id FROM nodes WHERE node_type = ? AND ref_id IN (${placeholders})`,
    ).all(nodeType, ...refIds) as { ref_id: number; id: number }[];
    for (const row of rows) map.set(row.ref_id, row.id);
    return map;
  }

  /** Resolve multiple node refs in one query. Returns Map<nodeId, {nodeType, refId}>. */
  getNodeRefsBatch(nodeIds: number[]): Map<number, { nodeType: string; refId: number }> {
    const map = new Map<number, { nodeType: string; refId: number }>();
    if (nodeIds.length === 0) return map;
    const placeholders = nodeIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, node_type, ref_id FROM nodes WHERE id IN (${placeholders})`,
    ).all(...nodeIds) as { id: number; node_type: string; ref_id: number }[];
    for (const row of rows) map.set(row.id, { nodeType: row.node_type, refId: row.ref_id });
    return map;
  }

  /** Batch-fetch symbols by internal IDs. Returns Map<id, SymbolRow>. */
  getSymbolsByIds(ids: number[]): Map<number, SymbolRow> {
    const map = new Map<number, SymbolRow>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM symbols WHERE id IN (${placeholders})`,
    ).all(...ids) as SymbolRow[];
    for (const row of rows) map.set(row.id, row);
    return map;
  }

  /** Batch-fetch files by internal IDs. Returns Map<id, FileRow>. */
  getFilesByIds(ids: number[]): Map<number, FileRow> {
    const map = new Map<number, FileRow>();
    if (ids.length === 0) return map;
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM files WHERE id IN (${placeholders})`,
    ).all(...ids) as FileRow[];
    for (const row of rows) map.set(row.id, row);
    return map;
  }

  /**
   * Fetch all edges where any of the given node IDs appear as source or target.
   * Returns edges annotated with edge_type_name and the pivot node id (the one from the input set).
   */
  getEdgesForNodesBatch(
    nodeIds: number[],
  ): Array<EdgeRow & { edge_type_name: string; pivot_node_id: number }> {
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT e.*, et.name AS edge_type_name
         FROM edges e
         JOIN edge_types et ON e.edge_type_id = et.id
        WHERE e.source_node_id IN (${placeholders})
           OR e.target_node_id IN (${placeholders})`,
    ).all(...nodeIds, ...nodeIds) as (EdgeRow & { edge_type_name: string })[];

    const nodeSet = new Set(nodeIds);
    return rows.map((row) => ({
      ...row,
      pivot_node_id: nodeSet.has(row.source_node_id) ? row.source_node_id : row.target_node_id,
    }));
  }

  /** Find a class/interface symbol by name with optional framework_role filter. Single query with JOIN. */
  findSymbolByRole(name: string, frameworkRole?: string): SymbolRow | undefined {
    if (frameworkRole) {
      return this.db.prepare(
        `SELECT s.* FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE f.framework_role = ?
           AND (s.name = ? OR s.fqn LIKE ?)
         LIMIT 1`,
      ).get(frameworkRole, name, `%\\${name}`) as SymbolRow | undefined;
    }
    return this.db.prepare(
      'SELECT * FROM symbols WHERE name = ? AND kind = ? LIMIT 1',
    ).get(name, 'class') as SymbolRow | undefined;
  }

  // --- Env vars ---

  insertEnvVar(fileId: number, entry: {
    key: string;
    valueType: string;
    valueFormat: string | null;
    comment: string | null;
    quoted: boolean;
    line: number;
  }): number {
    return (this.db.prepare(
      `INSERT INTO env_vars (file_id, key, value_type, value_format, comment, quoted, line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fileId, entry.key, entry.valueType, entry.valueFormat,
      entry.comment, entry.quoted ? 1 : 0, entry.line,
    ) as { lastInsertRowid: number }).lastInsertRowid as number;
  }

  deleteEnvVarsByFile(fileId: number): void {
    this.db.prepare('DELETE FROM env_vars WHERE file_id = ?').run(fileId);
  }

  getEnvVarsByFile(fileId: number): EnvVarRow[] {
    return this.db.prepare(
      'SELECT * FROM env_vars WHERE file_id = ? ORDER BY line',
    ).all(fileId) as EnvVarRow[];
  }

  getAllEnvVars(): (EnvVarRow & { file_path: string })[] {
    return this.db.prepare(
      `SELECT ev.*, f.path as file_path
       FROM env_vars ev
       JOIN files f ON ev.file_id = f.id
       ORDER BY f.path, ev.line`,
    ).all() as (EnvVarRow & { file_path: string })[];
  }

  searchEnvVars(pattern: string): (EnvVarRow & { file_path: string })[] {
    return this.db.prepare(
      `SELECT ev.*, f.path as file_path
       FROM env_vars ev
       JOIN files f ON ev.file_id = f.id
       WHERE ev.key LIKE ?
       ORDER BY f.path, ev.line`,
    ).all(`%${pattern}%`) as (EnvVarRow & { file_path: string })[];
  }

  // --- AI Summarization ---

  updateSymbolSummary(symbolId: number, summary: string): void {
    this.db.prepare('UPDATE symbols SET summary = ? WHERE id = ?').run(summary, symbolId);
  }

  getUnsummarizedSymbols(kinds: string[], limit: number): {
    id: number;
    name: string;
    fqn: string | null;
    kind: string;
    signature: string | null;
    file_path: string;
    byte_start: number;
    byte_end: number;
  }[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT s.id, s.name, s.fqn, s.kind, s.signature, f.path as file_path, s.byte_start, s.byte_end
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.summary IS NULL AND s.kind IN (${placeholders}) AND f.gitignored = 0
      LIMIT ?
    `).all(...kinds, limit) as {
      id: number;
      name: string;
      fqn: string | null;
      kind: string;
      signature: string | null;
      file_path: string;
      byte_start: number;
      byte_end: number;
    }[];
  }

  // --- Workspace / Monorepo ---

  /** Get all distinct workspaces with file/symbol counts. */
  getWorkspaceStats(): WorkspaceStats[] {
    return this.db.prepare(`
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
    `).all() as WorkspaceStats[];
  }

  /** Get all cross-workspace edges with resolved source/target workspace info. */
  getCrossWorkspaceEdges(): CrossWorkspaceEdge[] {
    return this.db.prepare(`
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
    `).all() as CrossWorkspaceEdge[];
  }

  /** Get workspace dependency summary: which workspaces depend on which. */
  getWorkspaceDependencyGraph(): WorkspaceDependency[] {
    return this.db.prepare(`
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
    `).all() as WorkspaceDependency[];
  }

  /** Get symbols in a workspace that are used by other workspaces (public API surface). */
  getWorkspaceExports(workspace: string): SymbolWithFilePath[] {
    return this.db.prepare(`
      SELECT DISTINCT s.*, f.path as file_path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      JOIN nodes n ON n.node_type = 'symbol' AND n.ref_id = s.id
      JOIN edges e ON e.target_node_id = n.id AND e.is_cross_ws = 1
      WHERE f.workspace = ?
      ORDER BY s.kind, s.name
    `).all(workspace) as SymbolWithFilePath[];
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
  gitignored: number;
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
  handler: string | null;
  controller_symbol_id: string | null;
  middleware: string | null;
  metadata: string | null;
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

export interface SymbolWithFilePath extends SymbolRow {
  file_path: string;
}

export interface EdgeTypeRow {
  name: string;
  category: string;
  description: string;
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
