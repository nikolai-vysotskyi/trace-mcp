/**
 * Post-index smoke: compare trace index DB SQL CTE counts to corpus spike expectations.
 *
 * Usage:
 *   npm run sql-index:smoke
 *   TRACE_SQL_INDEX_PROJECT=/path/to/repo npm run sql-index:smoke
 *   TRACE_INDEX_DB=/path/to/project.db npm run sql-index:smoke
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getDbPath } from '../src/global.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = process.env.TRACE_SQL_INDEX_PROJECT
  ? path.resolve(process.env.TRACE_SQL_INDEX_PROJECT)
  : null;
const dbPath = process.env.TRACE_INDEX_DB
  ? path.resolve(process.env.TRACE_INDEX_DB)
  : getDbPath(projectRoot);

const metricsPath = path.join(repoRoot, 'tests/sql-corpus/corpus-metrics.json');

interface SpikeReport {
  cte_count_ast?: number;
  cte_count_regex_first_only?: number;
  files?: number;
  expectations_source?: string;
}

function loadExpectations(projectRoot: string | null): SpikeReport {
  const fromEnv = process.env.TRACE_SQL_SMOKE_METRICS;
  if (fromEnv) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.resolve(fromEnv), 'utf8')) as SpikeReport;
      return { ...raw, expectations_source: fromEnv };
    } catch {
      /* fall through */
    }
  }

  if (projectRoot) {
    const syncPath = path.join(projectRoot, '.cursor/trace-sql-sync.json');
    if (fs.existsSync(syncPath)) {
      try {
        const sync = JSON.parse(fs.readFileSync(syncPath, 'utf8')) as {
          corpus?: {
            cte_count_ast?: number;
            cte_count_regex_first_only?: number;
            sql_files_scripts_queries?: number;
            files?: number;
          };
        };
        const c = sync.corpus;
        if (c?.cte_count_ast != null) {
          return {
            cte_count_ast: c.cte_count_ast,
            cte_count_regex_first_only: c.cte_count_regex_first_only,
            files: c.sql_files_scripts_queries ?? c.files,
            expectations_source: syncPath,
          };
        }
      } catch {
        /* fall through */
      }
    }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(metricsPath, 'utf8')) as SpikeReport;
    return {
      files: raw.files,
      cte_count_ast: raw.cte_count_ast,
      cte_count_regex_first_only: raw.cte_count_regex_first_only,
      expectations_source: metricsPath,
    };
  } catch {
    return {
      cte_count_ast: 15,
      cte_count_regex_first_only: 5,
      files: 8,
      expectations_source: 'builtin_fallback',
    };
  }
}

function main() {
  if (!projectRoot) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: 'TRACE_SQL_INDEX_PROJECT_required',
          hint: 'Set TRACE_SQL_INDEX_PROJECT to the indexed project root (private benchmark).',
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(
      JSON.stringify({ ok: false, error: 'index_db_not_found', dbPath, projectRoot }, null, 2),
    );
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const expectations = loadExpectations(projectRoot);

  const sqlPathSubstr = process.env.TRACE_SQL_INDEX_SQL_PATH_SUBSTR?.trim() ?? '';
  const sqlPathLike = sqlPathSubstr ? `%${sqlPathSubstr}%` : '%';
  const sqlFileFilter = sqlPathSubstr ? `path LIKE '%.sql' AND path LIKE ?` : `path LIKE '%.sql'`;
  const sqlJoinFilter = sqlPathSubstr
    ? `f.path LIKE '%.sql' AND f.path LIKE ?`
    : `f.path LIKE '%.sql'`;

  const sqlFiles = (
    sqlPathSubstr
      ? db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${sqlFileFilter}`).get(sqlPathLike)
      : db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${sqlFileFilter}`).get()
  ) as { n: number };

  const cteInQueries = (
    sqlPathSubstr
      ? db
          .prepare(
            `SELECT COUNT(*) AS n FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE ${sqlJoinFilter}
           AND s.kind = 'variable' AND s.metadata LIKE '%"sqlKind":"cte"%'`,
          )
          .get(sqlPathLike)
      : db
          .prepare(
            `SELECT COUNT(*) AS n FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE ${sqlJoinFilter}
           AND s.kind = 'variable' AND s.metadata LIKE '%"sqlKind":"cte"%'`,
          )
          .get()
  ) as { n: number };

  const astExtractor = (
    sqlPathSubstr
      ? db
          .prepare(
            `SELECT COUNT(*) AS n FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE ${sqlJoinFilter}
           AND s.metadata LIKE '%"extractor":"tree-sitter-sql"%'`,
          )
          .get(sqlPathLike)
      : db
          .prepare(
            `SELECT COUNT(*) AS n FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE ${sqlJoinFilter}
           AND s.metadata LIKE '%"extractor":"tree-sitter-sql"%'`,
          )
          .get()
  ) as { n: number };

  const fixtureTwoCteJoinSampleCtes = (
    db
      .prepare(
        `SELECT s.name FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.path LIKE '%two_cte_join_sample.sql' AND s.metadata LIKE '%"sqlKind":"cte"%'
         ORDER BY s.name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

  const sampleRow = db
    .prepare(
      `SELECT s.name, s.line_start, s.line_end, s.metadata FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.path LIKE '%two_cte_join_sample.sql' AND s.name = 'emp_age'`,
    )
    .get() as { name: string; line_start: number; line_end: number; metadata: string } | undefined;

  let sample_symbol_metadata: Record<string, unknown> | undefined;
  if (sampleRow?.metadata) {
    try {
      const parsed = JSON.parse(sampleRow.metadata) as Record<string, unknown>;
      sample_symbol_metadata = {
        symbol: sampleRow.name,
        lines: `${sampleRow.line_start}-${sampleRow.line_end}`,
        parseStatus: parsed.parseStatus,
        hasError: parsed.hasError,
        extractor: parsed.extractor,
        preprocessorApplied: parsed.preprocessorApplied,
        templates: (parsed.templates as Array<{ name: string }> | undefined)?.map((t) => t.name),
        bindParams: parsed.bindParams,
        relationRefCount: Array.isArray(parsed.relationRefs) ? parsed.relationRefs.length : 0,
      };
    } catch {
      sample_symbol_metadata = { error: 'metadata_json_parse_failed' };
    }
  }

  db.close();

  const expectedAst = expectations.cte_count_ast ?? 1022;
  const expectedRegex = expectations.cte_count_regex_first_only ?? 171;
  const cteDrift = expectedAst - cteInQueries.n;
  const astWired =
    astExtractor.n > 0 && cteInQueries.n >= expectedAst - 1 && cteInQueries.n <= expectedAst;
  const regexOnly =
    astExtractor.n === 0 &&
    cteInQueries.n <= expectedRegex + 5 &&
    cteInQueries.n >= expectedRegex - 5;

  const report = {
    ok: astWired,
    projectRoot,
    dbPath,
    sql_files_indexed: sqlFiles.n,
    sql_path_substr_filter: sqlPathSubstr || null,
    cte_symbols_in_sql_files: cteInQueries.n,
    cte_drift_vs_spike: cteDrift,
    ast_extractor_symbol_rows: astExtractor.n,
    expected_from_spike: {
      cte_count_ast: expectedAst,
      cte_count_regex_first_only: expectedRegex,
      sql_files: expectations.files ?? 249,
      source: expectations.expectations_source,
    },
    mode: astWired ? 'ast' : regexOnly ? 'regex_baseline' : 'unexpected',
    fixture_two_cte_join_sample_ctes: fixtureTwoCteJoinSampleCtes,
    sample_symbol_metadata,
    hint: regexOnly
      ? 'Index looks like regex-only (171 CTEs). Reindex with: node dist/cli.js index <project> --force (not global trace unless linked to this build).'
      : !astWired
        ? 'CTE count does not match spike AST expectation — reindex or check TRACE_SQL_AST=0.'
        : undefined,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
