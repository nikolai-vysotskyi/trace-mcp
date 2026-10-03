/**
 * P2 / escalation inventory: how often PG constructs appear in the benchmark corpus.
 * Usage: npx tsx scripts/sql-corpus-p2-inventory.ts [--out path.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spikeParseSqlSource } from '../src/indexer/plugins/language/sql/spike-parse.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus =
  process.env.TRACE_SQL_CORPUS_ROOT ??
  path.join(repoRoot, '../data-analytics-python/scripts/queries');

const FEATURES: Array<{ id: string; re: RegExp; phase: 'p2' | 'p1' | 'escalation' }> = [
  { id: 'recursive_cte', re: /\bWITH\s+RECURSIVE\b/i, phase: 'p2' },
  { id: 'returning', re: /\bRETURNING\b/i, phase: 'p2' },
  { id: 'on_conflict', re: /\bON\s+CONFLICT\b/i, phase: 'p2' },
  { id: 'dollar_quote', re: /\$[a-zA-Z0-9_]*\$/, phase: 'p2' },
  { id: 'generate_series', re: /\bGENERATE_SERIES\s*\(/i, phase: 'p2' },
  { id: 'unnest', re: /\bUNNEST\s*\(/i, phase: 'p2' },
  { id: 'do_block', re: /\bDO\s+\$\$/i, phase: 'p2' },
  { id: 'create_function', re: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/im, phase: 'p2' },
  { id: 'libpg_query_candidate', re: /\bDISTINCT\s+ON\s*\([^)]*::/i, phase: 'escalation' },
  { id: 'trivial_invalid_sql', re: /^\s*selec\b/i, phase: 'escalation' },
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
  const files = walk(corpus).sort();
  const counts: Record<string, number> = {};
  const byFile: Record<string, string[]> = {};
  const parseByFeature: Record<string, { partial: number; ok: number }> = {};

  for (const f of FEATURES) {
    counts[f.id] = 0;
    parseByFeature[f.id] = { partial: 0, ok: 0 };
  }

  for (const abs of files) {
    const text = fs.readFileSync(abs, 'utf8');
    const rel = path.relative(corpus, abs);
    const hitIds = FEATURES.filter((f) => f.re.test(text)).map((f) => f.id);
    if (hitIds.length) byFile[rel] = hitIds;
    const spike = await spikeParseSqlSource(text);
    for (const id of hitIds) {
      counts[id]++;
      if (spike.status === 'partial') parseByFeature[id].partial++;
      else if (spike.status === 'ok') parseByFeature[id].ok++;
    }
  }

  const report = {
    corpus_root: corpus,
    files: files.length,
    features: FEATURES.map((f) => ({
      id: f.id,
      phase: f.phase,
      pattern: f.re.source,
      file_count: counts[f.id],
      parse_ok: parseByFeature[f.id].ok,
      parse_partial: parseByFeature[f.id].partial,
    })),
    files_with_features: byFile,
  };

  const outArg = process.argv.indexOf('--out');
  const outPath =
    outArg >= 0 && process.argv[outArg + 1]
      ? path.resolve(process.argv[outArg + 1])
      : path.join(repoRoot, 'docs/sql-enhancement/p2-inventory.json');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
