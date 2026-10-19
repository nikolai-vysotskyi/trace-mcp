/**
 * Correlate repository SQL feature flags with partial tree-sitter parses.
 * Usage: npx tsx scripts/sql-partial-diagnostics.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spikeParseSqlSource } from '../src/indexer/plugins/language/sql/spike-parse.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus =
  process.env.TRACE_SQL_CORPUS_ROOT ?? path.join(repoRoot, 'tests/sql-corpus/fixtures');

const PATTERNS: Array<[string, RegExp]> = [
  ['distinct_on', /DISTINCT\s+ON\s*\(/i],
  ['materialized_cte', /\bAS\s+MATERIALIZED\s*\(/i],
  ['lateral', /\bLATERAL\b/i],
  ['window_over', /\bOVER\s*\(/i],
  ['jsonb', /jsonb|->>|->/i],
  ['filter_agg', /\bFILTER\s*\(/i],
  ['returning', /\bRETURNING\b/i],
  ['on_conflict', /\bON\s+CONFLICT\b/i],
  ['recursive_cte', /\bWITH\s+RECURSIVE\b/i],
  ['dollar_quote', /\$[a-zA-Z0-9_]*\$/],
  ['at_time_zone', /AT\s+TIME\s+ZONE/i],
  ['interval_lit', /interval\s+'/i],
  ['any_array', /\bANY\s*\(/i],
  ['format_brace', /(?<!\{)\{[a-z][a-z0-9_]*\}(?!\})/],
  ['double_colon_cast', /::[a-zA-Z]/],
  ['string_agg_distinct', /string_agg\s*\(\s*distinct/i],
  ['ilike', /\bILIKE\b/i],
  ['array_literal', /\bARRAY\s*\[/i],
  ['trivial_invalid_sql', /^\s*selec\b/i],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.sql')) out.push(p);
  }
  return out;
}

async function main() {
  const files = walk(corpus);
  const partial: Array<{ rel: string; flags: string[]; ctes: number }> = [];
  const ok: Array<{ rel: string; flags: string[] }> = [];

  for (const abs of files) {
    const text = fs.readFileSync(abs, 'utf8');
    const r = await spikeParseSqlSource(text);
    const rel = path.relative(corpus, abs);
    const flags = PATTERNS.filter(([, re]) => re.test(text)).map(([n]) => n);
    if (r.status === 'partial') partial.push({ rel, flags, ctes: r.ctes.length });
    else if (r.status === 'ok') ok.push({ rel, flags });
  }

  const lift = PATTERNS.map(([f]) => {
    const pc = partial.filter((r) => r.flags.includes(f)).length;
    const oc = ok.filter((r) => r.flags.includes(f)).length;
    return {
      feature: f,
      in_partial: pc,
      in_ok: oc,
      pct_of_partial: partial.length ? Math.round((pc / partial.length) * 100) : 0,
      pct_of_ok: ok.length ? Math.round((oc / ok.length) * 100) : 0,
    };
  })
    .filter((x) => x.in_partial > 0)
    .sort((a, b) => b.in_partial - a.in_partial);

  console.log(
    JSON.stringify(
      {
        corpus_files: files.length,
        ok: ok.length,
        partial: partial.length,
        failed: files.length - ok.length - partial.length,
        partial_with_no_known_flag: partial.filter((r) => r.flags.length === 0).length,
        partial_unflagged_files: partial.filter((r) => r.flags.length === 0).map((r) => r.rel),
        feature_lift: lift,
        sample_partial_files: partial.slice(0, 10).map((r) => r.rel),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
