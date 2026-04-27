/**
 * AsyncDbPlugin — Python async database driver/library plugin.
 *
 * Detects and extracts from:
 * - asyncpg (PostgreSQL): pool.fetch(), pool.fetchrow(), pool.execute(), conn.prepare()
 * - databases (encode/databases): database.fetch_all(), database.execute()
 * - aiosqlite: conn.execute(), conn.fetchall()
 * - psycopg (v3 async): conn.execute(), cursor.fetchone()
 * - tortoise-orm: Model.filter(), Model.create() (basic ORM patterns)
 *
 * Extracts:
 * - SQL query strings → table references
 * - Connection pool creation patterns → metadata
 * - Prepared statement patterns
 * - Transaction blocks (async with conn.transaction())
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  RawSymbol,
  ResolveContext,
  EdgeTypeDeclaration,
} from '../../../../../plugin-api/types.js';

// ============================================================
// Detection
// ============================================================

/** Async DB packages for Python. */
const ASYNC_DB_PACKAGES = [
  'asyncpg',
  'databases',
  'aiosqlite',
  'psycopg',
  'tortoise-orm',
  'piccolo',
  'asyncpgsa',
  'aiopg',
  'aiomysql',
  'motor', // async mongo
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasPythonDep(ctx: ProjectContext, packages: string[]): string | null {
  for (const pkg of packages) {
    const lowerPkg = pkg.toLowerCase();

    if (ctx.pyprojectToml) {
      const deps = ctx.pyprojectToml._parsedDeps as string[] | undefined;
      if (deps?.includes(lowerPkg)) return pkg;
    }

    if (
      ctx.requirementsTxt?.some((line) => {
        const pkgName = line
          .split(/[=<>!\[]/)[0]
          .trim()
          .toLowerCase();
        return pkgName === lowerPkg;
      })
    )
      return pkg;
  }

  // Fallback: read from disk
  for (const file of ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt']) {
    try {
      const content = fs.readFileSync(path.join(ctx.rootPath, file), 'utf-8');
      for (const pkg of packages) {
        const re = new RegExp(`${escapeRegExp(pkg)}`, 'i');
        if (re.test(content)) return pkg;
      }
    } catch {
      /* not found */
    }
  }

  return null;
}

// ============================================================
// Regex patterns for async DB calls
// ============================================================

// asyncpg patterns:
// pool.fetch('SELECT ...'), pool.fetchrow('...'), pool.fetchval('...')
// pool.execute('INSERT ...'), conn.executemany('...')
// conn.prepare('SELECT ...')
const ASYNCPG_CALL_RE =
  /\.(?:fetch|fetchrow|fetchval|execute|executemany|prepare|copy_from_query|copy_to_table)\s*\(\s*(?:f?)(["']{1,3})([\s\S]*?)\1/g;

// databases (encode/databases) patterns:
// database.fetch_all('SELECT ...'), database.fetch_one('...')
// database.execute('INSERT ...'), database.iterate('SELECT ...')
const DATABASES_CALL_RE =
  /\.(?:fetch_all|fetch_one|fetch_val|execute|execute_many|iterate)\s*\(\s*(?:query\s*=\s*)?(?:f?)(["']{1,3})([\s\S]*?)\1/g;

// aiosqlite / psycopg patterns:
// cursor.execute('SELECT ...'), conn.execute('...')
// cursor.fetchone(), cursor.fetchall(), cursor.fetchmany()
const GENERIC_ASYNC_SQL_RE =
  /\.(?:execute|executemany|mogrify)\s*\(\s*(?:f?)(["']{1,3})([\s\S]*?)\1/g;

// Connection pool / connect patterns:
// asyncpg.create_pool(dsn='...')
// asyncpg.connect('postgresql://...')
// databases.Database('postgresql://...')
const POOL_CREATE_RE =
  /(?:asyncpg\.create_pool|asyncpg\.connect|Database|create_pool|connect)\s*\(/g;

// Transaction patterns:
// async with conn.transaction():
// async with database.transaction():
const TRANSACTION_RE = /async\s+with\s+\w+\.transaction\s*\(/g;

// Tortoise ORM patterns (async ORM built on asyncpg/aiosqlite):
// await Model.filter(name='...').first()
// await Model.create(name='...')
// await Model.all()
// await Model.get(id=1)
const TORTOISE_MODEL_RE =
  /await\s+([A-Z]\w+)\.(?:filter|create|get|all|first|get_or_create|update_or_create|delete|count|exists|annotate|aggregate|select_for_update|bulk_create|bulk_update)\s*\(/g;

// Table reference extraction from SQL strings
const TABLE_FROM_SQL_RE =
  /(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`]?(\w+)["'`]?/gi;

const CREATE_TABLE_RE =
  /CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi;

// ============================================================
// SQL extraction
// ============================================================

interface AsyncDbStatement {
  kind: 'query' | 'mutation' | 'ddl' | 'transaction' | 'pool';
  sql?: string;
  tables: string[];
  line: number;
  driver: string;
}

function extractAsyncDbStatements(source: string): AsyncDbStatement[] {
  const statements: AsyncDbStatement[] = [];
  const seen = new Set<string>();

  function addSqlStatement(sql: string, line: number, driver: string): void {
    const upper = sql.trim().toUpperCase();
    const key = `${driver}:${line}:${upper.slice(0, 50)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const tables: string[] = [];

    // Extract table names
    let m: RegExpExecArray | null;
    const tableRe = new RegExp(TABLE_FROM_SQL_RE.source, 'gi');
    while ((m = tableRe.exec(sql)) !== null) {
      const t = m[1].toLowerCase();
      if (!SQL_KEYWORDS.has(t) && !tables.includes(t)) tables.push(t);
    }

    const createRe = new RegExp(CREATE_TABLE_RE.source, 'gi');
    while ((m = createRe.exec(sql)) !== null) {
      const t = m[1].toLowerCase();
      if (!tables.includes(t)) tables.push(t);
    }

    let kind: AsyncDbStatement['kind'] = 'query';
    if (/^\s*(?:INSERT|UPDATE|DELETE|UPSERT)/i.test(sql)) kind = 'mutation';
    else if (/^\s*(?:CREATE|ALTER|DROP|TRUNCATE)/i.test(sql)) kind = 'ddl';

    statements.push({ kind, sql: sql.slice(0, 200), tables, line, driver });
  }

  // asyncpg calls
  const asyncpgRe = new RegExp(ASYNCPG_CALL_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = asyncpgRe.exec(source)) !== null) {
    const sql = m[2];
    const line = source.slice(0, m.index).split('\n').length;
    addSqlStatement(sql, line, 'asyncpg');
  }

  // databases calls
  const dbRe = new RegExp(DATABASES_CALL_RE.source, 'g');
  while ((m = dbRe.exec(source)) !== null) {
    const sql = m[2];
    const line = source.slice(0, m.index).split('\n').length;
    addSqlStatement(sql, line, 'databases');
  }

  // Generic async SQL (aiosqlite, psycopg)
  const genRe = new RegExp(GENERIC_ASYNC_SQL_RE.source, 'g');
  while ((m = genRe.exec(source)) !== null) {
    const sql = m[2];
    const line = source.slice(0, m.index).split('\n').length;
    addSqlStatement(sql, line, 'async-sql');
  }

  // Pool creation
  const poolRe = new RegExp(POOL_CREATE_RE.source, 'g');
  while ((m = poolRe.exec(source)) !== null) {
    const line = source.slice(0, m.index).split('\n').length;
    statements.push({ kind: 'pool', tables: [], line, driver: 'asyncpg' });
  }

  // Transaction blocks
  const txRe = new RegExp(TRANSACTION_RE.source, 'g');
  while ((m = txRe.exec(source)) !== null) {
    const line = source.slice(0, m.index).split('\n').length;
    statements.push({ kind: 'transaction', tables: [], line, driver: 'async-db' });
  }

  return statements;
}

interface TortoiseModelRef {
  modelName: string;
  operation: string;
  line: number;
}

function extractTortoiseModels(source: string): TortoiseModelRef[] {
  const refs: TortoiseModelRef[] = [];
  const re = new RegExp(TORTOISE_MODEL_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const line = source.slice(0, m.index).split('\n').length;
    refs.push({
      modelName: m[1],
      operation: m[0].match(/\.(\w+)\s*\(/)![1],
      line,
    });
  }
  return refs;
}

/** SQL keywords that are NOT table names. */
const SQL_KEYWORDS = new Set([
  'select',
  'from',
  'where',
  'and',
  'or',
  'not',
  'in',
  'is',
  'null',
  'true',
  'false',
  'as',
  'on',
  'set',
  'values',
  'into',
  'table',
  'index',
  'if',
  'exists',
  'then',
  'else',
  'end',
  'case',
  'when',
  'order',
  'by',
  'group',
  'having',
  'limit',
  'offset',
  'union',
  'all',
  'join',
  'left',
  'right',
  'inner',
  'outer',
  'cross',
  'natural',
  'returning',
  'conflict',
  'nothing',
  'do',
  'update',
  'delete',
  'insert',
  'create',
  'alter',
  'drop',
  'truncate',
  'begin',
  'commit',
  'rollback',
  'with',
  'recursive',
  'temporary',
  'temp',
  'cascade',
  'restrict',
  'constraint',
  'primary',
  'foreign',
  'key',
  'references',
  'unique',
  'check',
  'default',
  'not',
  'null',
]);

// ============================================================
// Plugin
// ============================================================

export class AsyncDbPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'async-db',
    version: '1.0.0',
    priority: 25,
    category: 'orm',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasPythonDep(ctx, ASYNC_DB_PACKAGES) !== null;
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'async_db_query',
          category: 'async-db',
          description: 'Async DB query (SELECT/fetch)',
        },
        {
          name: 'async_db_mutation',
          category: 'async-db',
          description: 'Async DB mutation (INSERT/UPDATE/DELETE)',
        },
        {
          name: 'async_db_schema',
          category: 'async-db',
          description: 'Async DB schema operation (CREATE/ALTER/DROP)',
        },
        { name: 'async_db_pool', category: 'async-db', description: 'Connection pool creation' },
        {
          name: 'tortoise_model_op',
          category: 'async-db',
          description: 'Tortoise ORM model operation',
        },
      ] satisfies EdgeTypeDeclaration[],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'python') return ok({ status: 'ok', symbols: [] });

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    // Check for async DB imports
    const hasAsyncDbImport =
      /(?:import\s+asyncpg|from\s+asyncpg|from\s+databases|import\s+aiosqlite|from\s+aiosqlite|from\s+psycopg|from\s+tortoise|from\s+piccolo)/.test(
        source,
      );
    if (!hasAsyncDbImport) return ok(result);

    const statements = extractAsyncDbStatements(source);
    const tortoiseRefs = extractTortoiseModels(source);

    // Determine framework role
    if (statements.some((s) => s.kind === 'ddl')) {
      result.frameworkRole = 'db_schema';
    } else if (statements.some((s) => s.kind === 'pool')) {
      result.frameworkRole = 'db_config';
    } else if (statements.length > 0 || tortoiseRefs.length > 0) {
      result.frameworkRole = 'db_queries';
    }

    // Collect all referenced tables
    const allTables = new Set<string>();
    for (const stmt of statements) {
      for (const t of stmt.tables) allTables.add(t);
    }

    // Emit edges for SQL statements
    for (const stmt of statements) {
      if (stmt.tables.length === 0 && stmt.kind !== 'pool' && stmt.kind !== 'transaction') continue;

      let edgeType: string;
      switch (stmt.kind) {
        case 'query':
          edgeType = 'async_db_query';
          break;
        case 'mutation':
          edgeType = 'async_db_mutation';
          break;
        case 'ddl':
          edgeType = 'async_db_schema';
          break;
        case 'pool':
          edgeType = 'async_db_pool';
          break;
        default:
          continue;
      }

      result.edges!.push({
        edgeType,
        metadata: {
          driver: stmt.driver,
          tables: stmt.tables,
          sql: stmt.sql,
          line: stmt.line,
        },
      });
    }

    // Emit edges for Tortoise ORM model operations
    for (const ref of tortoiseRefs) {
      result.edges!.push({
        edgeType: 'tortoise_model_op',
        metadata: {
          model: ref.modelName,
          operation: ref.operation,
          line: ref.line,
        },
      });
    }

    // Create file-level metadata about database usage
    if (allTables.size > 0 || tortoiseRefs.length > 0) {
      const meta: Record<string, unknown> = {};
      if (allTables.size > 0) meta.tables = Array.from(allTables);
      if (tortoiseRefs.length > 0) {
        meta.tortoiseModels = [...new Set(tortoiseRefs.map((r) => r.modelName))];
      }

      const drivers = new Set(statements.map((s) => s.driver));
      if (drivers.size > 0) meta.drivers = Array.from(drivers);

      result.symbols!.push({
        symbolId: `${filePath}::__async_db__#variable`,
        name: '__async_db__',
        kind: 'variable',
        byteStart: 0,
        byteEnd: 0,
        metadata: meta,
      });
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
