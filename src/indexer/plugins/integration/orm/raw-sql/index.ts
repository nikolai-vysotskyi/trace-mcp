/**
 * RawSqlPlugin — detects projects using raw SQL drivers (better-sqlite3, sqlite3,
 * pg, mysql2, sql.js) and extracts SQL statements, table references, and schema
 * definitions from prepare/exec/query calls and embedded SQL strings.
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
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// --- Detection -----------------------------------------------------------------

const RAW_SQL_PACKAGES = [
  'better-sqlite3',
  'sqlite3',
  'sql.js',
  'pg',
  'mysql2',
  'mysql',
  'tedious',
  'oracledb',
];

// Python SQL drivers (detected via requirements/pyproject)
const PYTHON_SQL_PACKAGES = ['sqlite3', 'psycopg2', 'pymysql', 'asyncpg', 'aiosqlite'];

// --- Extraction patterns -------------------------------------------------------

// db.prepare('SELECT ...'), db.exec('CREATE TABLE ...'), pool.query('INSERT ...')
const SQL_CALL_RE = /\.(?:prepare|exec|execute|query|run|all|get)\(\s*[`'"]([\s\S]{5,500}?)[`'"]/g;

// CREATE TABLE name
const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi;

// Common DML: INSERT INTO / UPDATE / DELETE FROM / SELECT ... FROM
const TABLE_REF_RE = /(?:FROM|INTO|UPDATE|JOIN)\s+["'`]?(\w+)["'`]?/gi;

// db.pragma('...')
const PRAGMA_RE = /\.pragma\(\s*['"]([^'"]+)['"]/g;

// Import detection
const SQL_IMPORT_RE =
  /(?:import|require)\s*(?:\(|{)?\s*.*(?:better-sqlite3|sqlite3|sql\.js|Database)\b/;

// --- Helpers -------------------------------------------------------------------

interface SqlStatement {
  kind: 'ddl' | 'dml' | 'pragma';
  tables: string[];
  raw?: string;
}

function extractSqlStatements(source: string): SqlStatement[] {
  const results: SqlStatement[] = [];
  const seen = new Set<string>();

  // Extract SQL from calls
  const callRe = new RegExp(SQL_CALL_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const sql = m[1].trim();
    if (seen.has(sql)) continue;
    seen.add(sql);

    const tables: string[] = [];
    const isDdl = /^\s*(CREATE|ALTER|DROP)\s/i.test(sql);
    const isPragma = /^\s*pragma\s/i.test(sql);

    // Extract table names from CREATE TABLE
    const createRe = new RegExp(CREATE_TABLE_RE.source, 'gi');
    let cm: RegExpExecArray | null;
    while ((cm = createRe.exec(sql)) !== null) {
      if (!tables.includes(cm[1])) tables.push(cm[1]);
    }

    // Extract table names from DML
    const refRe = new RegExp(TABLE_REF_RE.source, 'gi');
    let rm: RegExpExecArray | null;
    while ((rm = refRe.exec(sql)) !== null) {
      const name = rm[1].toLowerCase();
      // Skip SQL keywords that match the pattern
      if (!['set', 'select', 'where', 'values', 'null', 'table'].includes(name)) {
        if (!tables.includes(rm[1])) tables.push(rm[1]);
      }
    }

    results.push({
      kind: isPragma ? 'pragma' : isDdl ? 'ddl' : 'dml',
      tables,
      raw: sql.length > 200 ? sql.slice(0, 200) + '…' : sql,
    });
  }

  // Extract pragmas
  const pragmaRe = new RegExp(PRAGMA_RE.source, 'g');
  while ((m = pragmaRe.exec(source)) !== null) {
    results.push({ kind: 'pragma', tables: [], raw: m[1] });
  }

  return results;
}

// --- Plugin --------------------------------------------------------------------

export class RawSqlPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'raw-sql',
    version: '1.0.0',
    priority: 30,
    category: 'orm',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    // Node.js
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      for (const pkg of RAW_SQL_PACKAGES) {
        if (pkg in deps) return true;
      }
    }

    // Python
    if (ctx.requirementsTxt) {
      for (const line of ctx.requirementsTxt) {
        const pkgName = line
          .split(/[=<>!]/)[0]
          .trim()
          .toLowerCase();
        if (PYTHON_SQL_PACKAGES.includes(pkgName)) return true;
      }
    }

    // Fallback: read package.json from disk
    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const p of RAW_SQL_PACKAGES) {
        if (p in deps) return true;
      }
    } catch {
      /* not a node project */
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'sql_query', category: 'sql', description: 'Raw SQL query against a table' },
        { name: 'sql_schema', category: 'sql', description: 'DDL schema definition' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript', 'python'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };

    const hasImport = SQL_IMPORT_RE.test(source);
    const statements = extractSqlStatements(source);

    if (statements.length > 0) {
      const hasDdl = statements.some((s) => s.kind === 'ddl');
      result.frameworkRole = hasDdl ? 'sql_schema' : 'sql_queries';
    } else if (hasImport) {
      result.frameworkRole = 'sql_client';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];
    return ok(edges);
  }
}
