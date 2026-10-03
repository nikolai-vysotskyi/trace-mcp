/**
 * Benchmark-repo inventory: static Python → `.sql` file references (Phase 4 prep).
 * Usage: npx tsx scripts/sql-python-loader-inventory.ts [--out path.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchmarkRoot = path.join(repoRoot, '../data-analytics-python');

const PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'read_sql_file', re: /\bread_sql_file\s*\(/g },
  { id: 'render_sql_file', re: /\brender_sql_file\s*\(/g },
  { id: 'load_query_sql', re: /\bload_query_sql\s*\(/g },
  { id: 'load_sql_with_connectorx', re: /\bload_sql_with_connectorx\s*\(/g },
  { id: 'load_sql_with_benchmark', re: /\bload_sql_with_benchmark\s*\(/g },
  { id: 'sql_path_string', re: /['"](?:scripts\/)?queries\/[^'"]+\.sql['"]/g },
  { id: 'path_join_sql', re: /Path\s*\([^)]*\.sql[^)]*\)/g },
];

function walkPy(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '.venv') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkPy(p, out);
    else if (ent.name.endsWith('.py')) out.push(p);
  }
  return out;
}

function main() {
  if (!fs.existsSync(benchmarkRoot)) {
    console.error('Benchmark repo not found:', benchmarkRoot);
    process.exit(1);
  }

  const pyFiles = walkPy(benchmarkRoot);
  const totals: Record<string, number> = {};
  const byFile: Record<string, Record<string, number>> = {};

  for (const { id } of PATTERNS) totals[id] = 0;

  for (const abs of pyFiles) {
    const text = fs.readFileSync(abs, 'utf8');
    const rel = path.relative(benchmarkRoot, abs);
    const fileCounts: Record<string, number> = {};
    for (const { id, re } of PATTERNS) {
      const m = text.match(re);
      const n = m?.length ?? 0;
      if (n) {
        totals[id] += n;
        fileCounts[id] = n;
      }
    }
    if (Object.keys(fileCounts).length) byFile[rel] = fileCounts;
  }

  const report = {
    benchmark_root: benchmarkRoot,
    python_files_scanned: pyFiles.length,
    pattern_totals: totals,
    files_with_matches: Object.keys(byFile).length,
    top_callers: Object.entries(byFile)
      .map(([rel, counts]) => ({
        path: rel,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        ...counts,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 40),
    phase4_edge_proposal: {
      type: 'loads_sql',
      from: 'python symbol or file',
      to: 'scripts/queries/*.sql file node',
      resolution: 'resolve string literal / Path(...) under repo root',
    },
  };

  const outArg = process.argv.indexOf('--out');
  const outPath =
    outArg >= 0 && process.argv[outArg + 1]
      ? path.resolve(process.argv[outArg + 1])
      : path.join(repoRoot, 'docs/sql-enhancement/python-loader-inventory.json');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, top_callers: report.top_callers.slice(0, 5) }, null, 2));
}

main();
