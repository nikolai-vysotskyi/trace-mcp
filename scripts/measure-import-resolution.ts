#!/usr/bin/env tsx
/**
 * TRA-1145 — how much of what a language's import resolver *attempts* on a
 * real repo actually lands as a graph edge, broken down by language.
 *
 * `docs/language-matrix.md`'s Imports column is binary (a resolver pass
 * exists, yes/no). It already carries one measured exception in prose — C#
 * resolves 12 of ~5,000 `using` directives on Newtonsoft.Json — because a
 * resolver existing says nothing about how much of a real codebase it
 * actually connects. This script generalizes that one-off measurement to
 * every language with an import resolver, on one real public repo per
 * language, and prints the `{ created, external, ambiguous }` breakdown each
 * resolver already logs (src/indexer/edge-resolvers/*-imports.ts) — this
 * reuses that existing instrumentation rather than adding new counters.
 *
 * `external` is not a failure: a resolver that recognizes a specifier names
 * an npm/PyPI/crate/gem package correctly leaves it unresolved (that target
 * is not in this repo). `ambiguous` (ruby, c/cpp) is a specifier matching
 * more than one candidate file, left unresolved on purpose. Only `created`
 * lands as a graph edge.
 *
 * Usage: npx tsx scripts/measure-import-resolution.ts [--json out.json]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TraceMcpConfigSchema } from '../src/config.js';
import { initializeDatabase } from '../src/db/schema.js';
import { Store } from '../src/db/store.js';
import { IndexingPipeline } from '../src/indexer/pipeline.js';
import { PluginRegistry } from '../src/plugin-api/registry.js';

const CACHE_ROOT = path.join(os.homedir(), '.trace', 'import-resolution-bench');

interface RepoSpec {
  language: string;
  repo: string; // owner/name
  note?: string;
}

// One well-known real repo per language with an import-edge resolver
// (src/indexer/edge-resolvers/import-capable-languages.ts). go and csharp
// repeat measurements already quoted in docs (TRA-451, the language-matrix
// C# callout) as a consistency check; the rest are new.
const REPOS: RepoSpec[] = [
  { language: 'go', repo: 'spf13/cobra' },
  { language: 'csharp', repo: 'JamesNK/Newtonsoft.Json' },
  { language: 'python', repo: 'pallets/flask' },
  { language: 'ruby', repo: 'sinatra/sinatra' },
  { language: 'rust', repo: 'BurntSushi/ripgrep' },
  { language: 'java', repo: 'google/gson' },
  { language: 'kotlin', repo: 'square/okhttp' },
  { language: 'c', repo: 'curl/curl' },
  { language: 'cpp', repo: 'fmtlib/fmt' },
];

function sh(cmd: string[], cwd?: string): void {
  execFileSync(cmd[0], cmd.slice(1), { cwd, stdio: 'inherit' });
}

function ensureClone(spec: RepoSpec): string {
  const dir = path.join(CACHE_ROOT, spec.language);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  sh(['git', 'clone', '--depth', '1', `https://github.com/${spec.repo}.git`, dir]);
  return dir;
}

interface ResolverLine {
  edges?: number;
  phantomEdges?: number;
  external?: number;
  ambiguous?: number;
  pruned?: number;
  msg: string;
}

async function indexAndCapture(spec: RepoSpec, root: string): Promise<ResolverLine[]> {
  const tmpDb = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-import-bench-'));
  const dbPath = path.join(tmpDb, 'index.db');
  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  const registry = PluginRegistry.createWithDefaults();
  const config = TraceMcpConfigSchema.parse({ root });
  const pipeline = new IndexingPipeline(store, registry, config, root);

  const lines: ResolverLine[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    for (const line of text.split('\n')) {
      if (!line.includes('import edges resolved') && !line.includes('import edges')) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.msg === 'string' && parsed.msg.toLowerCase().includes('import')) {
          lines.push(parsed);
        }
      } catch {
        // not JSON — ignore
      }
    }
    // biome-ignore lint: bench instrumentation, not production code
    return (origWrite as any)(chunk, ...args);
  }) as typeof process.stderr.write;

  try {
    await pipeline.indexAll(false);
  } finally {
    process.stderr.write = origWrite;
    await pipeline.dispose();
    db.close();
    fs.rmSync(tmpDb, { recursive: true, force: true });
  }
  return lines;
}

async function main(): Promise<void> {
  const results: Array<{
    language: string;
    repo: string;
    commit: string;
    created: number;
    external: number;
    ambiguous: number;
    resolvedShare: string;
  }> = [];

  for (const spec of REPOS) {
    const root = ensureClone(spec);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
    }).trim();
    process.stdout.write(`Indexing ${spec.repo} for ${spec.language}...\n`);
    const lines = await indexAndCapture(spec, root);
    const created = lines.reduce((s, l) => s + (l.edges ?? 0), 0);
    const external = lines.reduce((s, l) => s + (l.external ?? l.phantomEdges ?? 0), 0);
    const ambiguous = lines.reduce((s, l) => s + (l.ambiguous ?? 0), 0);
    const attempted = created + external + ambiguous;
    const resolvedShare = attempted > 0 ? `${((created / attempted) * 100).toFixed(1)}%` : 'n/a';
    results.push({
      language: spec.language,
      repo: spec.repo,
      commit: commit.slice(0, 12),
      created,
      external,
      ambiguous,
      resolvedShare,
    });
    process.stdout.write(
      `  ${spec.language}: created=${created} external=${external} ambiguous=${ambiguous} (of local imports resolved: ${resolvedShare})\n`,
    );
  }

  const jsonFlag = process.argv.indexOf('--json');
  if (jsonFlag !== -1) {
    fs.writeFileSync(process.argv[jsonFlag + 1], JSON.stringify(results, null, 2));
  }

  process.stdout.write('\n| Language | Repo | Commit | Created | External | Ambiguous |\n');
  process.stdout.write('| --- | --- | --- | ---: | ---: | ---: |\n');
  for (const r of results) {
    process.stdout.write(
      `| ${r.language} | ${r.repo} | ${r.commit} | ${r.created} | ${r.external} | ${r.ambiguous} |\n`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
