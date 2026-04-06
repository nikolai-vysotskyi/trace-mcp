/**
 * Laravel migration parsing — Schema::create/table/drop extraction.
 * Extracts table names, columns, and timestamps from migration files.
 */
import type { RawMigration } from '../../../../../plugin-api/types.js';

/** Column type mapping from Laravel Blueprint methods. */
const COLUMN_TYPES: Record<string, string> = {
  id: 'bigint',
  bigIncrements: 'bigint',
  increments: 'integer',
  string: 'varchar',
  text: 'text',
  longText: 'longtext',
  mediumText: 'mediumtext',
  integer: 'integer',
  bigInteger: 'bigint',
  smallInteger: 'smallint',
  tinyInteger: 'tinyint',
  float: 'float',
  double: 'double',
  decimal: 'decimal',
  boolean: 'boolean',
  date: 'date',
  dateTime: 'datetime',
  timestamp: 'timestamp',
  time: 'time',
  json: 'json',
  jsonb: 'jsonb',
  binary: 'blob',
  uuid: 'uuid',
  foreignId: 'bigint',
  unsignedBigInteger: 'bigint',
  unsignedInteger: 'integer',
  enum: 'enum',
  timestamps: 'timestamps',
  softDeletes: 'timestamp',
  rememberToken: 'varchar',
  nullableTimestamps: 'timestamps',
  morphs: 'morphs',
  nullableMorphs: 'morphs',
  uuidMorphs: 'morphs',
};

interface MigrationColumn {
  name: string;
  type: string;
  nullable?: boolean;
  unique?: boolean;
  default?: string;
}

interface MigrationExtractionResult {
  migrations: RawMigration[];
  warnings: string[];
}

/**
 * Extract migration data from a PHP migration file.
 * Only parses the up() method to avoid capturing down() operations.
 */
export function extractMigrations(
  source: string,
  filePath: string,
): MigrationExtractionResult {
  const migrations: RawMigration[] = [];
  const warnings: string[] = [];
  const timestamp = extractTimestamp(filePath);

  // Extract only the up() method body to avoid parsing down() method
  const upBody = extractUpMethodBody(source) ?? source;

  // Schema::create('table', function (...) { ... })
  extractSchemaCreate(upBody, timestamp, migrations);

  // Schema::table('table', function (...) { ... })
  extractSchemaTable(upBody, timestamp, migrations);

  // Schema::drop('table') and Schema::dropIfExists('table')
  extractSchemaDrop(upBody, timestamp, migrations);

  return { migrations, warnings };
}

/** Extract the body of the up() method. */
function extractUpMethodBody(source: string): string | null {
  // Match: public function up()... { ... }
  // Use a brace-counting approach to handle nested braces
  const upStart = source.match(/public\s+function\s+up\s*\([^)]*\)(?:\s*:\s*\w+)?\s*\{/);
  if (!upStart || upStart.index === undefined) return null;

  let braceCount = 1;
  let pos = upStart.index + upStart[0].length;
  const start = pos;

  while (pos < source.length && braceCount > 0) {
    if (source[pos] === '{') braceCount++;
    else if (source[pos] === '}') braceCount--;
    pos++;
  }

  return source.substring(start, pos - 1);
}

/** Extract timestamp from migration filename (e.g. 2024_01_01_000000_...). */
export function extractTimestamp(filePath: string): string | undefined {
  const match = filePath.match(/(\d{4}_\d{2}_\d{2}_\d{6})/);
  return match ? match[1] : undefined;
}

/** Parse Schema::create calls. */
function extractSchemaCreate(
  source: string,
  timestamp: string | undefined,
  migrations: RawMigration[],
): void {
  const regex = /Schema::create\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const tableName = match[1];
    const body = match[2];
    const columns = extractColumns(body);

    migrations.push({
      tableName,
      operation: 'create',
      columns,
      timestamp,
    });
  }
}

/** Parse Schema::table calls (alter). */
function extractSchemaTable(
  source: string,
  timestamp: string | undefined,
  migrations: RawMigration[],
): void {
  const regex = /Schema::table\s*\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    const tableName = match[1];
    const body = match[2];
    const columns = extractColumns(body);

    migrations.push({
      tableName,
      operation: 'alter',
      columns,
      timestamp,
    });
  }
}

/** Parse Schema::drop and Schema::dropIfExists calls. */
function extractSchemaDrop(
  source: string,
  timestamp: string | undefined,
  migrations: RawMigration[],
): void {
  const regex = /Schema::(?:drop|dropIfExists)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    migrations.push({
      tableName: match[1],
      operation: 'drop',
      timestamp,
    });
  }
}

/** Extract column definitions from a migration body. */
function extractColumns(body: string): Record<string, unknown>[] {
  const columns: Record<string, unknown>[] = [];
  const methodNames = Object.keys(COLUMN_TYPES).join('|');

  // Match: $table->string('name'), $table->id(), $table->timestamps(), etc.
  const regex = new RegExp(
    `\\$table->(${methodNames})\\s*\\(\\s*(?:['"]([^'"]*)['"'])?[^)]*\\)([^;]*);`,
    'g',
  );

  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const method = match[1];
    const columnName = match[2];
    const chain = match[3] ?? '';
    const type = COLUMN_TYPES[method] ?? method;

    // Special methods that don't have a column name (timestamps, softDeletes, etc.)
    if (!columnName && (method === 'timestamps' || method === 'nullableTimestamps')) {
      columns.push({ name: 'created_at', type: 'timestamp', nullable: true });
      columns.push({ name: 'updated_at', type: 'timestamp', nullable: true });
      continue;
    }

    if (!columnName && method === 'softDeletes') {
      columns.push({ name: 'deleted_at', type: 'timestamp', nullable: true });
      continue;
    }

    if (!columnName && method === 'rememberToken') {
      columns.push({ name: 'remember_token', type: 'varchar', nullable: true });
      continue;
    }

    if (!columnName && method === 'id') {
      columns.push({ name: 'id', type: 'bigint', autoIncrement: true, primary: true });
      continue;
    }

    if (!columnName) continue;

    const col: Record<string, unknown> = { name: columnName, type };
    if (chain.includes('->nullable()')) col.nullable = true;
    if (chain.includes('->unique()')) col.unique = true;
    if (chain.includes('->constrained()')) col.foreign = true;

    const defaultMatch = chain.match(/->default\s*\(\s*['"]?([^'")\s]+)['"]?\s*\)/);
    if (defaultMatch) col.default = defaultMatch[1];

    columns.push(col);
  }

  return columns;
}
