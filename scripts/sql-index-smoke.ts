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
const defaultProject = path.join(repoRoot, '../data-analytics-python');
const projectRoot = path.resolve(process.env.TRACE_SQL_INDEX_PROJECT ?? defaultProject);
const dbPath = process.env.TRACE_INDEX_DB
  ? path.resolve(process.env.TRACE_INDEX_DB)
  : getDbPath(projectRoot);

const spikeReportPath = path.join(repoRoot, 'docs/sql-enhancement/phase-2-spike-report.json');

interface SpikeReport {
  cte_count_ast?: number;
  cte_count_regex_first_only?: number;
  files?: number;
}

function loadExpectations(): SpikeReport {
  try {
    return JSON.parse(fs.readFileSync(spikeReportPath, 'utf8')) as SpikeReport;
  } catch {
    return { cte_count_ast: 1021, cte_count_regex_first_only: 171, files: 249 };
  }
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(
      JSON.stringify({ ok: false, error: 'index_db_not_found', dbPath, projectRoot }, null, 2),
    );
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const expectations = loadExpectations();

  const sqlFiles = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM files WHERE path LIKE '%.sql' AND path LIKE '%scripts/queries%'`,
      )
      .get() as { n: number }
  ).n;

  const cteInQueries = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.path LIKE '%scripts/queries%' AND f.path LIKE '%.sql'
           AND s.kind = 'variable' AND s.metadata LIKE '%"sqlKind":"cte"%'`,
      )
      .get() as { n: number }
  ).n;

  const astExtractor = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.path LIKE '%scripts/queries%' AND f.path LIKE '%.sql'
           AND s.metadata LIKE '%"extractor":"tree-sitter-sql"%'`,
      )
      .get() as { n: number }
  ).n;

  const baseOwnershipCtes = (
    db
      .prepare(
        `SELECT s.name FROM symbols s
         JOIN files f ON f.id = s.file_id
         WHERE f.path LIKE '%base_ownership.sql' AND s.metadata LIKE '%"sqlKind":"cte"%'
         ORDER BY s.name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

  const sampleRow = db
    .prepare(
      `SELECT s.name, s.line_start, s.line_end, s.metadata FROM symbols s
       JOIN files f ON f.id = s.file_id
       WHERE f.path LIKE '%base_ownership.sql' AND s.name = 'emp_age'`,
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
  const cteDrift = expectedAst - cteInQueries;
  const astWired =
    astExtractor > 0 && cteInQueries >= expectedAst - 1 && cteInQueries <= expectedAst;
  const regexOnly =
    astExtractor === 0 && cteInQueries <= expectedRegex + 5 && cteInQueries >= expectedRegex - 5;

  const report = {
    ok: astWired,
    projectRoot,
    dbPath,
    sql_files_under_scripts_queries: sqlFiles,
    cte_symbols_scripts_queries: cteInQueries,
    cte_drift_vs_spike: cteDrift,
    ast_extractor_symbol_rows: astExtractor,
    expected_from_spike: {
      cte_count_ast: expectedAst,
      cte_count_regex_first_only: expectedRegex,
      sql_files: expectations.files ?? 249,
    },
    mode: astWired ? 'ast' : regexOnly ? 'regex_baseline' : 'unexpected',
    fixture_base_ownership_ctes: baseOwnershipCtes,
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
