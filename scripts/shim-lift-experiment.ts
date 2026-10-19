/**
 * Try candidate parse-only shims on partial corpus files; count partial→ok flips.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWasmPath } from 'tree-sitter-wasm';
import { Parser, Language } from 'web-tree-sitter';
import { preprocessSqlForParse } from '../src/indexer/plugins/language/sql/preprocess.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus =
  process.env.TRACE_SQL_CORPUS_ROOT ?? path.join(repoRoot, 'tests/sql-corpus/fixtures');

type Shim = { name: string; apply: (s: string) => string };

const SHIMS: Shim[] = [
  { name: 'materialized_cte', apply: (s) => s.replace(/\bAS\s+MATERIALIZED\s*\(/gi, 'AS (') },
  { name: 'ilike_to_like', apply: (s) => s.replace(/\bILIKE\b/gi, 'LIKE') },
  {
    name: 'filter_where_strip',
    apply: (s) => s.replace(/\s+FILTER\s*\(\s*WHERE[^)]*\)/gi, ''),
  },
  { name: 'jsonb_cast_text', apply: (s) => s.replace(/::jsonb\b/gi, '::text') },
  {
    name: 'jsonb_operators',
    apply: (s) => s.replace(/->>/g, '/*jsonb*/').replace(/->/g, '/*jsonb*/'),
  },
  {
    name: 'pg_cast_to_text',
    apply: (s) => s.replace(/::[a-zA-Z_][a-zA-Z0-9_]*/g, '::text'),
  },
  {
    name: 'interval_simplify',
    apply: (s) => s.replace(/interval\s+'[^']*'/gi, "interval '1 day'"),
  },
];

let parser: Parser;
let ready = false;

async function ensureParser() {
  if (ready) return;
  await Parser.init();
  const lang = await Language.load(getWasmPath('sql'));
  parser = new Parser();
  parser.setLanguage(lang);
  ready = true;
}

function parseOk(source: string): boolean {
  const tree = parser.parse(source);
  const ok =
    (tree.rootNode.type === 'program' || tree.rootNode.type === 'statement') &&
    !tree.rootNode.hasError;
  tree.delete();
  return ok;
}

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
  await ensureParser();
  const files = walk(corpus);
  const partialFiles: string[] = [];
  for (const abs of files) {
    const pre = preprocessSqlForParse(fs.readFileSync(abs, 'utf8')).source;
    if (!parseOk(pre)) partialFiles.push(abs);
  }

  const results: Array<{ name: string; flips: number; files: string[] }> = [];

  for (const shim of SHIMS) {
    const flipped: string[] = [];
    for (const abs of partialFiles) {
      const pre = preprocessSqlForParse(fs.readFileSync(abs, 'utf8')).source;
      if (parseOk(pre)) continue;
      const next = shim.apply(pre);
      if (parseOk(next)) flipped.push(path.relative(corpus, abs));
    }
    results.push({ name: shim.name, flips: flipped.length, files: flipped.slice(0, 15) });
  }

  // Combined: all shims that had flips > 0
  const combined = SHIMS.filter((s) => results.find((r) => r.name === s.name && r.flips > 0));
  let comboFlips = 0;
  const comboFiles: string[] = [];
  for (const abs of partialFiles) {
    let pre = preprocessSqlForParse(fs.readFileSync(abs, 'utf8')).source;
    if (parseOk(pre)) continue;
    for (const shim of combined) pre = shim.apply(pre);
    if (parseOk(pre)) {
      comboFlips++;
      comboFiles.push(path.relative(corpus, abs));
    }
  }

  console.log(
    JSON.stringify(
      {
        partial_baseline: partialFiles.length,
        per_shim: results.sort((a, b) => b.flips - a.flips),
        combined_shims: combined.map((s) => s.name),
        combined_flips: comboFlips,
        combined_sample: comboFiles.slice(0, 20),
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
