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
}

export function getSchema(
  store: Store,
  tableName?: string,
): TraceMcpResult<SchemaResult> {
  const tables: TableSchema[] = [];

  if (tableName) {
    const schema = reconstructTable(store, tableName);
    if (schema) tables.push(schema);
  } else {
    // Get all unique table names
    const migrations = store.getAllMigrations();
    const tableNames = [...new Set(migrations.map((m) => m.table_name))];
    for (const name of tableNames) {
      const schema = reconstructTable(store, name);
      if (schema) tables.push(schema);
    }
  }

  return ok({ tables });
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
