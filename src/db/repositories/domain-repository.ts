import type Database from 'better-sqlite3';
import type {
  RawRoute,
  RawComponent,
  RawMigration,
  RawOrmModel,
  RawRnScreen,
} from '../../plugin-api/types.js';
import type {
  RouteRow,
  ComponentRow,
  MigrationRow,
  OrmModelRow,
  OrmAssociationRow,
  RnScreenRow,
} from '../types.js';

export class DomainRepository {
  constructor(private readonly db: Database.Database) {}

  // --- Routes ---

  insertRoute(
    route: RawRoute,
    fileId: number,
    createNode: (nodeType: string, refId: number) => number,
  ): number {
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

    const mwArray = route.middleware ?? [];
    let middlewareJson: string | null = null;
    if (controllerRef || mwArray.length > 0) {
      middlewareJson = JSON.stringify({
        middleware: mwArray,
        ...(controllerRef ? { controllerRef } : {}),
      });
    }

    const result = this.db
      .prepare(
        `INSERT INTO routes (method, uri, name, controller_symbol_id, middleware, file_id, line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        route.method,
        route.uri,
        route.name ?? null,
        resolvedControllerSymId,
        middlewareJson,
        fileId,
        route.line ?? null,
      );
    const routeId = Number(result.lastInsertRowid);
    createNode('route', routeId);
    return routeId;
  }

  getRouteByUriAndMethod(uri: string, method: string): RouteRow | undefined {
    return this.db.prepare('SELECT * FROM routes WHERE uri = ? AND method = ?').get(uri, method) as
      | RouteRow
      | undefined;
  }

  getAllRoutes(): RouteRow[] {
    return this.db.prepare('SELECT * FROM routes').all() as RouteRow[];
  }

  findRouteByPattern(uri: string, method: string): RouteRow | undefined {
    const likePattern = uri.replace(/\{[^}]+\}/g, '%');
    const routes = this.db
      .prepare('SELECT * FROM routes WHERE method = ? AND uri LIKE ?')
      .all(method.toUpperCase(), likePattern) as RouteRow[];
    const exact = routes.find((r) => r.uri === uri);
    return exact ?? routes[0];
  }

  // --- Components ---

  insertComponent(
    comp: RawComponent,
    fileId: number,
    createNode: (nodeType: string, refId: number) => number,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO components (file_id, name, kind, props, emits, slots, composables, framework)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    createNode('component', compId);
    return compId;
  }

  getComponentByFileId(fileId: number): ComponentRow | undefined {
    return this.db.prepare('SELECT * FROM components WHERE file_id = ?').get(fileId) as
      | ComponentRow
      | undefined;
  }

  getComponentByName(name: string): ComponentRow | undefined {
    return this.db.prepare('SELECT * FROM components WHERE name = ?').get(name) as
      | ComponentRow
      | undefined;
  }

  getAllComponents(): ComponentRow[] {
    return this.db.prepare('SELECT * FROM components').all() as ComponentRow[];
  }

  // --- Migrations ---

  insertMigration(
    mig: RawMigration,
    fileId: number,
    createNode: (nodeType: string, refId: number) => number,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO migrations (file_id, table_name, operation, columns, indices, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        mig.tableName,
        mig.operation,
        mig.columns ? JSON.stringify(mig.columns) : null,
        mig.indices ? JSON.stringify(mig.indices) : null,
        mig.timestamp ?? null,
      );
    const migId = Number(result.lastInsertRowid);
    createNode('migration', migId);
    return migId;
  }

  getMigrationsByTable(tableName: string): MigrationRow[] {
    return this.db
      .prepare('SELECT * FROM migrations WHERE table_name = ? ORDER BY timestamp ASC')
      .all(tableName) as MigrationRow[];
  }

  getAllMigrations(): MigrationRow[] {
    return this.db
      .prepare('SELECT * FROM migrations ORDER BY timestamp ASC')
      .all() as MigrationRow[];
  }

  // --- ORM Models ---

  insertOrmModel(
    model: RawOrmModel,
    fileId: number,
    createNode: (nodeType: string, refId: number) => number,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO orm_models (file_id, name, orm, collection_or_table, fields, options, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        model.name,
        model.orm,
        model.collectionOrTable ?? null,
        model.fields ? JSON.stringify(model.fields) : null,
        model.options ? JSON.stringify(model.options) : null,
        model.metadata ? JSON.stringify(model.metadata) : null,
      );
    const modelId = Number(result.lastInsertRowid);
    createNode('orm_model', modelId);
    return modelId;
  }

  getOrmModelByName(name: string): OrmModelRow | undefined {
    return this.db.prepare('SELECT * FROM orm_models WHERE name = ?').get(name) as
      | OrmModelRow
      | undefined;
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
    const result = this.db
      .prepare(
        `INSERT INTO orm_associations (source_model_id, target_model_id, target_model_name, kind, options, file_id, line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

  getAllOrmAssociations(fileIds?: number[]): OrmAssociationRow[] {
    if (fileIds && fileIds.length > 0) {
      const ph = fileIds.map(() => '?').join(',');
      return this.db
        .prepare(`SELECT * FROM orm_associations WHERE file_id IN (${ph})`)
        .all(...fileIds) as OrmAssociationRow[];
    }
    return this.db.prepare('SELECT * FROM orm_associations').all() as OrmAssociationRow[];
  }

  getOrmAssociationsByModel(modelId: number): OrmAssociationRow[] {
    return this.db
      .prepare('SELECT * FROM orm_associations WHERE source_model_id = ?')
      .all(modelId) as OrmAssociationRow[];
  }

  // --- React Native Screens ---

  insertRnScreen(
    screen: RawRnScreen,
    fileId: number,
    createNode: (nodeType: string, refId: number) => number,
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO rn_screens (file_id, name, component_path, navigator_type, options, deep_link, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fileId,
        screen.name,
        screen.componentPath ?? null,
        screen.navigatorType ?? null,
        screen.options ? JSON.stringify(screen.options) : null,
        screen.deepLink ?? null,
        screen.metadata ? JSON.stringify(screen.metadata) : null,
      );
    const screenId = Number(result.lastInsertRowid);
    createNode('rn_screen', screenId);
    return screenId;
  }

  getRnScreenByName(name: string): RnScreenRow | undefined {
    return this.db.prepare('SELECT * FROM rn_screens WHERE name = ?').get(name) as
      | RnScreenRow
      | undefined;
  }

  getAllRnScreens(): RnScreenRow[] {
    return this.db.prepare('SELECT * FROM rn_screens').all() as RnScreenRow[];
  }
}
