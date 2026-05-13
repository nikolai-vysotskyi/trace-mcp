/**
 * `trace-mcp eval` command — P04 vertical slice.
 *
 * Subcommands:
 *   - `eval run --dataset <slug> [--k N] [--output md|json] [--out-file path]`
 *       runs the benchmark and prints a Markdown rollup (or JSON).
 *   - `eval list` — lists bundled dataset slugs.
 *
 * The command resolves the index DB path the same way `trace-mcp search`
 * does: registered project root → registered DB path, else fall back to
 * the default global DB.
 *
 * NOTE: this file is intentionally standalone. It is not wired into
 * `src/cli.ts` in this slice — see plan-cognee-P04-IMPL.md for the wiring
 * note (the Wave 1 R09 agent owns cli.ts in the current branch ordering).
 * The exported `evalCommand` can be `program.addCommand`-ed directly
 * when cli.ts is unblocked.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { ensureGlobalDirs, getDbPath } from '../global.js';
import { findProjectRoot, hasRootMarkers } from '../project-root.js';
import { getProject } from '../registry.js';
import { listDatasets, loadDataset } from '../eval/datasets/loader.js';
import { BenchmarkRunner, formatReportMarkdown } from '../eval/runner.js';

interface RunOpts {
  dataset: string;
  k: string;
  output: 'md' | 'json';
  outFile?: string;
}

function resolveDbPath(projectRoot: string): string {
  const entry = getProject(projectRoot);
  if (entry) return entry.dbPath;
  return getDbPath(projectRoot);
}

export const evalCommand = new Command('eval').description(
  'Run code-intelligence benchmarks against the local trace-mcp index (P04 slice)',
);

evalCommand
  .command('run')
  .description('Execute a benchmark dataset and emit a metrics report')
  .requiredOption('--dataset <slug>', 'Dataset slug to run (e.g. "default")')
  .option('--k <n>', 'Top-K depth for precision@K and rank scoring', '5')
  .option('--output <fmt>', 'Output format: md | json', 'md')
  .option('--out-file <path>', 'Write the report to a file instead of stdout')
  .action(async (opts: RunOpts) => {
    const k = Math.max(1, parseInt(opts.k, 10) || 5);
    if (opts.output !== 'md' && opts.output !== 'json') {
      console.error(`Unknown --output "${opts.output}". Choices: md, json.`);
      process.exit(2);
    }

    let dataset;
    try {
      dataset = loadDataset(opts.dataset);
    } catch (err) {
      console.error(`Failed to load dataset "${opts.dataset}":`);
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
      return;
    }

    const cwd = process.cwd();
    let projectRoot: string;
    try {
      projectRoot = findProjectRoot(cwd);
    } catch {
      if (hasRootMarkers(cwd)) {
        projectRoot = cwd;
      } else {
        console.error(`No project found in ${cwd}. Run \`trace-mcp add\` first.`);
        process.exit(1);
        return;
      }
    }

    const entry = getProject(projectRoot);
    if (!entry) {
      console.error(`Project not indexed. Run \`trace-mcp add ${projectRoot}\` first.`);
      process.exit(1);
      return;
    }

    ensureGlobalDirs();
    const dbPath = resolveDbPath(projectRoot);
    if (!fs.existsSync(dbPath)) {
      console.error(`Index DB not found at ${dbPath}. Run \`trace-mcp add\` to index first.`);
      process.exit(1);
      return;
    }

    const runner = new BenchmarkRunner(dataset, { dbPath, k });
    const report = await runner.run();

    const body =
      opts.output === 'json'
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${formatReportMarkdown(report)}\n`;

    if (opts.outFile) {
      const outPath = path.resolve(opts.outFile);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, body, 'utf-8');
      console.log(`Wrote ${opts.output} report to ${outPath}`);
    } else {
      process.stdout.write(body);
    }
  });

evalCommand
  .command('list')
  .description('List bundled benchmark dataset slugs')
  .action(() => {
    const slugs = listDatasets();
    if (slugs.length === 0) {
      console.log('(no datasets found)');
      return;
    }
    for (const s of slugs) console.log(s);
  });
