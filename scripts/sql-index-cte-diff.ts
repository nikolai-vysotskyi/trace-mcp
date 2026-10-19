/**
 * Compare per-file AST CTE counts: spike parser vs trace index DB.
 *
 * Usage:
 *   npm run sql-index:cte-diff
 *   TRACE_SQL_INDEX_PROJECT=... TRACE_INDEX_DB=... npm run sql-index:cte-diff
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { getDbPath } from '../src/global.js';
import { spikeParseSqlSource } from '../src/indexer/plugins/language/sql/spike-parse.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = process.env.TRACE_SQL_INDEX_PROJECT
  ? path.resolve(process.env.TRACE_SQL_INDEX_PROJECT)
  : null;
const dbPath = process.env.TRACE_INDEX_DB
  ? path.resolve(process.env.TRACE_INDEX_DB)
  : getDbPath(projectRoot);
const corpusRoot = process.env.TRACE_SQL_CORPUS_ROOT
  ? path.resolve(process.env.TRACE_SQL_CORPUS_ROOT)
  : null;

function walkSql(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSql(p, out);
    else if (ent.name.endsWith('.sql')) out.push(p);
  }
  return out;
}

async function main() {
  if (!projectRoot) {
    console.error(
      JSON.stringify({ ok: false, error: 'TRACE_SQL_INDEX_PROJECT_required' }, null, 2),
    );
    process.exit(1);
  }
  if (!fs.existsSync(dbPath)) {
    console.error(JSON.stringify({ ok: false, error: 'index_db_not_found', dbPath }, null, 2));
    process.exit(1);
  }
  if (!corpusRoot) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: 'TRACE_SQL_CORPUS_ROOT_required',
          hint: 'Set TRACE_SQL_CORPUS_ROOT to the .sql tree to diff (e.g. public fixtures or your private corpus).',
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  if (!fs.existsSync(corpusRoot)) {
    console.error(JSON.stringify({ ok: false, error: 'corpus_not_found', corpusRoot }, null, 2));
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM symbols s
     JOIN files f ON f.id = s.file_id
     WHERE f.path LIKE ? AND s.kind = 'variable' AND s.metadata LIKE '%"sqlKind":"cte"%'`,
  );

  let spikeTotal = 0;
  let indexTotal = 0;
  const diffs: Array<{ rel: string; spike: number; index: number; status: string }> = [];

  for (const abs of walkSql(corpusRoot).sort()) {
    const rel = path.relative(corpusRoot, abs).replace(/\\/g, '/');
    const original = fs.readFileSync(abs, 'utf8');
    const spike = await spikeParseSqlSource(original);
    const sc = spike.ctes.length;
    spikeTotal += sc;
    const suffix = `%${rel}`;
    const ic = (countStmt.get(suffix) as { n: number }).n;
    indexTotal += ic;
    if (sc !== ic) diffs.push({ rel, spike: sc, index: ic, status: spike.status });
  }

  db.close();

  const drift = spikeTotal - indexTotal;
  const report = {
    ok: drift === 0,
    projectRoot,
    dbPath,
    corpusRoot,
    spikeTotal,
    indexTotal,
    drift,
    files_with_mismatch: diffs.length,
    diffs,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
