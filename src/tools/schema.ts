/**
 * get_schema tool — reconstructs database schema from migrations.
 * Returns columns, types, and structure for a table or all tables.
 */
import type { Store } from '../db/store.js';
import { ok, type TraceMcpResult } from '../errors.js';

export interface TableColumn {
  name: string;
  type: string;
  nullable?: boolean;
  unique?: boolean;
  primary?: boolean;
  foreign?: boolean;
  default?: string;
  autoIncrement?: boolean;
}

export interface TableSchema {
  tableName: string;
  columns: TableColumn[];
  operations: { operation: string; timestamp?: string }[];
}

export interface SchemaResult {
  tables: TableSchema[];
  /** Mongoose/Sequelize ORM schemas (collections or model schemas) */
  ormSchemas?: OrmSchema[];
}

export interface OrmSchema {
  name: string;
  orm: string;
  collection: string | undefined;
  fields: Record<string, unknown>[];
  indexes?: Record<string, unknown>[];
}

export function getSchema(
  store: Store,
  tableName?: string,
): TraceMcpResult<SchemaResult> {
  const tables: TableSchema[] = [];
  const ormSchemas: OrmSchema[] = [];

  if (tableName) {
    // Try SQL migrations first
    const schema = reconstructTable(store, tableName);
    if (schema) tables.push(schema);

    // Also try ORM model by name or collection
    const allOrm = store.getAllOrmModels();
    const ormMatch = allOrm.find(
      (m) =>
        m.name.toLowerCase() === tableName.toLowerCase() ||
        m.collection_or_table?.toLowerCase() === tableName.toLowerCase(),
    );
    if (ormMatch) {
      ormSchemas.push(buildOrmSchema(ormMatch));
    }
  } else {
    // All SQL tables
    const migrations = store.getAllMigrations();
    const tableNames = [...new Set(migrations.map((m) => m.table_name))];
    for (const name of tableNames) {
      const schema = reconstructTable(store, name);
      if (schema) tables.push(schema);
    }

    // All ORM models
    for (const m of store.getAllOrmModels()) {
      ormSchemas.push(buildOrmSchema(m));
    }
  }

  return ok({
    tables,
    ...(ormSchemas.length > 0 ? { ormSchemas } : {}),
  });
}

function buildOrmSchema(model: { name: string; orm: string; collection_or_table: string | null; fields: string | null; metadata: string | null }): OrmSchema {
  const fields: Record<string, unknown>[] = model.fields ? JSON.parse(model.fields) : [];
  const meta: Record<string, unknown> = model.metadata ? JSON.parse(model.metadata) : {};
  return {
    name: model.name,
    orm: model.orm,
    collection: model.collection_or_table ?? undefined,
    fields,
    ...(meta.indexes ? { indexes: meta.indexes as Record<string, unknown>[] } : {}),
  };
}

function reconstructTable(store: Store, tableName: string): TableSchema | null {
  const migrations = store.getMigrationsByTable(tableName);
  if (migrations.length === 0) return null;

  const columns: TableColumn[] = [];
  const operations: { operation: string; timestamp?: string }[] = [];
  const columnMap = new Map<string, TableColumn>();

  for (const mig of migrations) {
    operations.push({
      operation: mig.operation,
      timestamp: mig.timestamp ?? undefined,
    });

    if (mig.operation === 'drop') {
      // Table dropped — clear columns
      columnMap.clear();
      continue;
    }

    if (mig.columns) {
      const cols = JSON.parse(mig.columns) as Record<string, unknown>[];
      for (const col of cols) {
        const name = col.name as string;
        if (!name) continue;

        const tableCol: TableColumn = {
          name,
          type: (col.type as string) ?? 'unknown',
        };
        if (col.nullable) tableCol.nullable = true;
        if (col.unique) tableCol.unique = true;
        if (col.primary) tableCol.primary = true;
        if (col.foreign) tableCol.foreign = true;
        if (col.autoIncrement) tableCol.autoIncrement = true;
        if (col.default !== undefined) tableCol.default = String(col.default);

        columnMap.set(name, tableCol);
      }
    }
  }

  return {
    tableName,
    columns: [...columnMap.values()],
    operations,
  };
}
