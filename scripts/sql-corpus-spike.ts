/**
 * Phase 2 corpus spike: tree-sitter-sql + template preprocessing across all .sql files.
 *
 * Usage: npx tsx scripts/sql-corpus-spike.ts [--out path.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spikeParseSqlSource } from '../src/indexer/plugins/language/sql/spike-parse.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCorpus = path.join(repoRoot, 'tests/sql-corpus/fixtures');
const corpusRoot = process.env.TRACE_SQL_CORPUS_ROOT
  ? path.resolve(process.env.TRACE_SQL_CORPUS_ROOT)
  : defaultCorpus;

const CTE_REGEX_FIRST = /\bWITH\s+(?:RECURSIVE\s+)?([a-zA-Z_]\w*)\s+AS\s*\(/gim;

function walkSql(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkSql(p, out);
    else if (ent.name.endsWith('.sql')) out.push(p);
  }
  return out;
}

function regexFirstCteCount(text: string): number {
  const m = text.match(CTE_REGEX_FIRST);
  return m?.length ?? 0;
}

async function main() {
  if (!fs.existsSync(corpusRoot)) {
    console.error('Corpus not found:', corpusRoot);
    process.exit(1);
  }

  const files = walkSql(corpusRoot).sort();
  const started = Date.now();
  const byStatus = { ok: 0, partial: 0, failed: 0 };
  let cteCountAst = 0;
  let cteCountRegexFirst = 0;
  const failures: Array<{ rel: string; error: string }> = [];

  for (const abs of files) {
    const rel = path.relative(corpusRoot, abs);
    const original = fs.readFileSync(abs, 'utf8');
    cteCountRegexFirst += regexFirstCteCount(original);
    const result = await spikeParseSqlSource(original);
    byStatus[result.status]++;
    cteCountAst += result.ctes.length;
    if (result.status === 'failed') {
      failures.push({ rel, error: result.error ?? 'unknown' });
    }
  }

  const report = {
    phase: 2,
    trace_mcp_version: '3.34.6',
    parser: 'tree-sitter-sql (tree-sitter-wasm)',
    preprocessor:
      'template_mustache + python_format_braces + bind_param + pg_distinct_on_join + pg_materialized_cte + pg_ilike_to_like + pg_at_time_zone_fold',
    corpus_root: corpusRoot,
    elapsed_ms: Date.now() - started,
    files: files.length,
    parse_status: byStatus,
    cte_count_ast: cteCountAst,
    cte_count_regex_first_only: cteCountRegexFirst,
    baseline_inventory: path.join(repoRoot, 'tests/sql-corpus/baseline-inventory.json'),
    failures_sample: failures.slice(0, 25),
    failure_total: failures.length,
  };

  const outArg = process.argv.indexOf('--out');
  const outPath =
    outArg >= 0 && process.argv[outArg + 1]
      ? path.resolve(process.argv[outArg + 1])
      : path.join(repoRoot, 'docs/sql-enhancement/phase-2-spike-report.json');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
