#!/usr/bin/env tsx
/**
 * TRA-534 — how many input tokens does trace-mcp context save on a real code
 * review, versus the naive "diff + every file it touches" an agent without an
 * index has to load?
 *
 * Two arms over the same pinned set of merged PRs, same tokenizer, same
 * assembled-prompt shape:
 *
 *   baseline  = review instructions + unified diff + full text of every source
 *               file the diff touches (at the PR head).
 *   trace-mcp = review instructions + unified diff + for each changed symbol,
 *               its source and imports (get_context_bundle) plus its dependents
 *               (get_change_impact).
 *
 * Usage:
 *   tsx scripts/bench-pr-context.ts --mine     # rebuild the pinned PR set via gh
 *   tsx scripts/bench-pr-context.ts            # run the benchmark
 *   tsx scripts/bench-pr-context.ts --limit 10 # smoke run on the first 10 PRs
 *
 * Inputs:  benchmarks/pr-context/dataset.json   — pinned repo + PR + base/head SHA
 * Outputs: benchmarks/pr-context/results.json   — per-PR rows + aggregates
 *          node_modules/.cache/pr-context/<repo> — upstream clones, reused
 *
 * The token numbers are exact (gpt-tokenizer over the assembled prompt), not
 * estimated. The quality columns are structural coverage, not an LLM judgement
 * — see docs/pr-context-benchmark.md for what that does and does not prove.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from 'gpt-tokenizer';
import { loadConfig } from '../src/config.js';
import { initializeDatabase } from '../src/db/schema.js';
import { Store } from '../src/db/store.js';
import { IndexingPipeline } from '../src/indexer/pipeline.js';
import { PluginRegistry } from '../src/plugin-api/registry.js';
import { measuredBuild } from './measured-build.js';
import { getChangeImpact } from '../src/tools/analysis/impact.js';
import { getContextBundle } from '../src/tools/navigation/context-bundle.js';
import { getChangedSymbols } from '../src/tools/quality/changed-symbols.js';

const ROOT = process.cwd();
const BENCH_DIR = path.join(ROOT, 'benchmarks/pr-context');
const DATASET_PATH = path.join(BENCH_DIR, 'dataset.json');
const RESULTS_PATH = path.join(BENCH_DIR, 'results.json');
// Clones live under node_modules/.cache so vitest, biome and trace-mcp's own
// indexer never walk them — an upstream repo's test suite is not ours to run.
const CACHE_DIR = path.join(ROOT, 'node_modules/.cache/pr-context');
const DOCS_DATA_PATH = path.join(ROOT, 'docs/_data/pr_context_bench.json');

/** Repos to mine from. Moderate size, actively maintained, languages we index. */
const MINE_REPOS = [
  'honojs/hono',
  'axios/axios',
  'expressjs/express',
  'psf/requests',
  'pallets/flask',
  'sindresorhus/got',
];
const MINE_PER_REPO = 12;

/**
 * Pricing for the cost column. One named model, stated in the docs page so the
 * number is auditable. Claude Sonnet 4.5 input, USD per million tokens.
 * ponytail: a constant, not a config — the docs page names it explicitly.
 */
const MODEL_NAME = 'claude-sonnet-4-5';
const INPUT_USD_PER_MTOK = 3.0;

/** Context windows we report overflow against. */
const CONTEXT_WINDOW = 200_000;

/** Budget handed to the trace-mcp arm's context bundle, per PR. */
const BUNDLE_TOKEN_BUDGET = 8000;

interface PrEntry {
  repo: string;
  number: number;
  title: string;
  base_sha: string;
  head_sha: string;
  changed_files: number;
  url: string;
}

interface ArmResult {
  tokens: number;
  /** Fraction of changed symbols whose full body is readable in the context. */
  changed_symbol_readable: number | null;
  /** Fraction of dependent symbols whose body is readable in the context. */
  dependent_readable: number | null;
  /** Fraction of dependent symbols at least named with a location. */
  dependent_pointed: number | null;
}

interface PrResult {
  repo: string;
  number: number;
  url: string;
  changed_files: number;
  changed_symbols: number;
  dependents: number;
  baseline: ArmResult;
  trace: ArmResult;
  savings_pct: number;
  index_ms: number;
}

const REVIEW_PREAMBLE = `You are reviewing a pull request. Identify correctness bugs,
edge cases the change misses, and call sites the change breaks. Report findings
with file and line. Below is the change under review, followed by the context
you have been given.

`;

function tokens(text: string): number {
  return encode(text).length;
}

function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer, timeout: 300_000 });
}

/**
 * Network calls to github.com flake often enough over a 70-PR run to drop
 * several rows from the artifact. Retry so a re-run reproduces the same row
 * count rather than a random subset.
 */
function gitRetry(cwd: string, args: string[], attempts = 3): string {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return git(cwd, args);
    } catch (e) {
      lastErr = e;
      execFileSync('sleep', [String(2 * (i + 1))]);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- mining

function mine(): void {
  const entries: PrEntry[] = [];
  for (const repo of MINE_REPOS) {
    const raw = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'merged',
        '--search',
        'fix in:title',
        '--limit',
        String(MINE_PER_REPO * 3),
        '--json',
        'number,title,baseRefOid,headRefOid,changedFiles,url',
      ],
      { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
    );
    const prs = JSON.parse(raw) as Array<{
      number: number;
      title: string;
      baseRefOid: string;
      headRefOid: string;
      changedFiles: number;
      url: string;
    }>;
    // 1..20 files: below 1 there is nothing to review, above 20 the naive arm
    // is not something an agent would even attempt and the pair stops being
    // comparable.
    const usable = prs
      .filter((p) => p.changedFiles >= 1 && p.changedFiles <= 20 && p.baseRefOid && p.headRefOid)
      .slice(0, MINE_PER_REPO);
    for (const p of usable) {
      entries.push({
        repo,
        number: p.number,
        title: p.title,
        base_sha: p.baseRefOid,
        head_sha: p.headRefOid,
        changed_files: p.changedFiles,
        url: p.url,
      });
    }
    console.log(`${repo}: ${usable.length} PRs`);
  }
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  fs.writeFileSync(DATASET_PATH, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Wrote ${entries.length} PRs → ${DATASET_PATH}`);
}

// ---------------------------------------------------------------- checkout

function repoDir(repo: string): string {
  return path.join(CACHE_DIR, repo.replace('/', '__'));
}

/** Clone once per repo, then fetch the exact PR head and detach onto it. */
function checkout(entry: PrEntry): { dir: string; head: string } {
  const dir = repoDir(entry.repo);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // A full clone on purpose: with --filter=blob:none every `git diff` in the
    // run lazily fetches blobs over the network, which turned a third of the
    // rows into transient failures. Disk is cheaper than a non-reproducible
    // row count.
    gitRetry(CACHE_DIR, ['clone', `https://github.com/${entry.repo}.git`, dir]);
  }
  gitRetry(dir, ['fetch', '--quiet', 'origin', `+refs/pull/${entry.number}/head:refs/bench/pr`]);
  gitRetry(dir, ['fetch', '--quiet', 'origin', entry.base_sha]);
  // Check out refs/pull/N/head rather than the dataset's head_sha: once a PR's
  // branch is deleted its OID stops being fetchable, while the pull ref is
  // immutable for a merged PR. That ref, not the branch tip, is the real pin —
  // head_sha stays in the dataset as a record of what the branch pointed at.
  const head = git(dir, ['rev-parse', 'refs/bench/pr']).trim();
  gitRetry(dir, ['checkout', '--quiet', '--force', head]);
  git(dir, ['clean', '-qfdx', '-e', '.trace-mcp']);
  return { dir, head };
}

// ---------------------------------------------------------------- arms

/**
 * Line spans a context makes visible, per file. Both coverage metrics are
 * "is this (file, line) inside something the reviewer can actually read".
 */
type Spans = Map<string, Array<[number, number]>>;

function addSpan(spans: Spans, file: string, start: number, end: number): void {
  const key = file.replace(/\\/g, '/');
  const list = spans.get(key) ?? [];
  list.push([start, end]);
  spans.set(key, list);
}

function covers(spans: Spans, file: string, line: number): boolean {
  const list = spans.get(file.replace(/\\/g, '/'));
  if (!list) return false;
  return list.some(([s, e]) => line >= s && line <= e);
}

function readFileSafe(dir: string, rel: string): string | undefined {
  const abs = path.join(dir, rel);
  if (!abs.startsWith(path.resolve(dir) + path.sep) && abs !== path.resolve(dir)) return undefined;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return undefined;
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Baseline: the diff plus every file it touches, whole. */
function buildBaseline(dir: string, diff: string, files: string[]): { text: string; spans: Spans } {
  const spans: Spans = new Map();
  const parts = [REVIEW_PREAMBLE, '## Diff\n\n```diff\n', diff, '\n```\n\n## Files touched\n\n'];
  for (const rel of files) {
    const content = readFileSafe(dir, rel);
    if (content === undefined) continue;
    parts.push(`### ${rel}\n\n\`\`\`\n${content}\n\`\`\`\n\n`);
    addSpan(spans, rel, 1, content.split('\n').length);
  }
  return { text: parts.join(''), spans };
}

/** Resolve a symbol_id to its file and line span, via the index. */
function siteOf(store: Store, symbolId: string): SymbolSite | undefined {
  const sym = store.getSymbolBySymbolId(symbolId);
  if (!sym) return undefined;
  const file = store.getFileById(sym.file_id);
  if (!file) return undefined;
  return { file: file.path, line_start: sym.line_start, line_end: sym.line_end };
}

/** trace-mcp: the diff plus changed-symbol bodies, their imports, and dependents. */
function buildTrace(
  store: Store,
  dir: string,
  diff: string,
  symbolIds: string[],
): { text: string; readable: Spans; pointed: Spans } {
  // `readable` = code the reviewer can actually read. `pointed` = readable plus
  // anything named with a location, which is all the impact list gives.
  const readable: Spans = new Map();
  const pointed: Spans = new Map();
  const parts = [REVIEW_PREAMBLE, '## Diff\n\n```diff\n', diff, '\n```\n\n'];

  const bundle = getContextBundle(store, dir, {
    symbolIds,
    includeCallers: true,
    tokenBudget: BUNDLE_TOKEN_BUDGET,
    outputFormat: 'markdown',
  });
  if (bundle.isOk()) {
    parts.push(bundle.value.content ?? '');
    for (const group of [bundle.value.primary, bundle.value.dependencies, bundle.value.callers]) {
      for (const item of group ?? []) {
        const site = siteOf(store, item.symbol_id);
        if (!site) continue;
        addSpan(readable, site.file, site.line_start, site.line_end);
        addSpan(pointed, site.file, site.line_start, site.line_end);
      }
    }
  }

  parts.push('\n## Impact — call sites this change can break\n\n');
  const listed = new Set<string>();
  for (const id of symbolIds) {
    const impact = getChangeImpact(store, { symbolId: id, depth: 2, maxDependents: 50 });
    if (impact.isErr()) continue;
    for (const dep of impact.value.dependents ?? []) {
      for (const s of dep.symbols ?? []) {
        if (listed.has(s.symbolId)) continue;
        listed.add(s.symbolId);
        const site = siteOf(store, s.symbolId);
        parts.push(
          `- ${dep.path}:${site?.line_start ?? '?'} ${s.symbolName} (${s.symbolKind}, depth ${dep.depth})\n`,
        );
        if (site) addSpan(pointed, site.file, site.line_start, site.line_end);
      }
    }
  }

  return { text: parts.join(''), readable, pointed };
}

// ---------------------------------------------------------------- run

interface SymbolSite {
  file: string;
  line_start: number;
  line_end: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, i)];
}

async function runOne(entry: PrEntry): Promise<PrResult | null> {
  const { dir, head } = checkout(entry);

  const diff = git(dir, ['diff', '--unified=3', `${entry.base_sha}..${head}`]);
  if (!diff.trim()) return null;

  const files = git(dir, ['diff', '--name-only', '--diff-filter=AMR', `${entry.base_sha}..${head}`])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (files.length === 0) return null;

  // Index the PR head — the state a review agent would have in front of it.
  const t0 = Date.now();
  const configResult = await loadConfig(dir);
  if (configResult.isErr()) return null;
  const dbPath = path.join(dir, '.trace-mcp', 'bench.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  const registry = PluginRegistry.createWithDefaults();
  const pipeline = new IndexingPipeline(store, registry, configResult.value, dir);
  await pipeline.indexAll(false);
  const indexMs = Date.now() - t0;

  try {
    const changed = getChangedSymbols(store, dir, {
      since: entry.base_sha,
      until: head,
    });
    if (changed.isErr()) throw new Error(`getChangedSymbols: ${JSON.stringify(changed.error)}`);
    const symbolIds = [...new Set(changed.value.changedSymbols.map((s) => s.symbolId))].filter(
      Boolean,
    );
    // No indexed symbol touched — a docs/config/lockfile PR. There is no
    // symbol-level context to build, so the pair is not comparable; excluding
    // these keeps the headline number from being inflated by PRs where the
    // trace-mcp arm would be nothing but the diff.
    if (symbolIds.length === 0) return null;

    // Ground truth, computed from the graph and independent of either arm:
    // where each changed symbol lives, and every call site into it.
    const changedSites = symbolIds
      .map((id) => siteOf(store, id))
      .filter((s): s is SymbolSite => Boolean(s));

    const dependentIds = new Set<string>();
    for (const id of symbolIds) {
      const impact = getChangeImpact(store, { symbolId: id, depth: 1, maxDependents: 200 });
      if (impact.isErr()) continue;
      for (const dep of impact.value.dependents ?? []) {
        for (const s of dep.symbols ?? []) dependentIds.add(s.symbolId);
      }
    }
    const dependentSites = [...dependentIds]
      .filter((id) => !symbolIds.includes(id))
      .map((id) => siteOf(store, id))
      .filter((s): s is SymbolSite => Boolean(s));

    const baseline = buildBaseline(dir, diff, files);
    const trace = buildTrace(store, dir, diff, symbolIds);

    /** null when there is nothing to score — never a vacuous 1.0. */
    const score = (spans: Spans, sites: SymbolSite[]): number | null => {
      if (sites.length === 0) return null;
      const hit = sites.filter(
        (s) => covers(spans, s.file, s.line_start) && covers(spans, s.file, s.line_end),
      ).length;
      return hit / sites.length;
    };

    const baseTokens = tokens(baseline.text);
    const traceTokens = tokens(trace.text);

    return {
      repo: entry.repo,
      number: entry.number,
      url: entry.url,
      changed_files: files.length,
      changed_symbols: symbolIds.length,
      dependents: dependentSites.length,
      baseline: {
        tokens: baseTokens,
        changed_symbol_readable: score(baseline.spans, changedSites),
        dependent_readable: score(baseline.spans, dependentSites),
        dependent_pointed: score(baseline.spans, dependentSites),
      },
      trace: {
        tokens: traceTokens,
        changed_symbol_readable: score(trace.readable, changedSites),
        dependent_readable: score(trace.readable, dependentSites),
        dependent_pointed: score(trace.pointed, dependentSites),
      },
      savings_pct: baseTokens > 0 ? ((baseTokens - traceTokens) / baseTokens) * 100 : 0,
      index_ms: indexMs,
    };
  } finally {
    await pipeline.dispose();
    db.close();
  }
}

async function run(limit?: number): Promise<void> {
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8')) as PrEntry[];
  const entries = limit ? dataset.slice(0, limit) : dataset;
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const rows: PrResult[] = [];
  const skipped: Array<{ repo: string; number: number; reason: string }> = [];
  for (const [i, entry] of entries.entries()) {
    process.stderr.write(`[${i + 1}/${entries.length}] ${entry.repo}#${entry.number} … `);
    try {
      const r = await runOne(entry);
      if (!r) {
        skipped.push({
          repo: entry.repo,
          number: entry.number,
          reason: 'no indexed symbol changed (docs/config/lockfile-only diff)',
        });
        process.stderr.write('skipped\n');
        continue;
      }
      rows.push(r);
      process.stderr.write(
        `${r.baseline.tokens} → ${r.trace.tokens} (${r.savings_pct.toFixed(0)}%)\n`,
      );
    } catch (e) {
      skipped.push({
        repo: entry.repo,
        number: entry.number,
        reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
      process.stderr.write('failed\n');
    }
  }

  const b = rows.map((r) => r.baseline.tokens);
  const t = rows.map((r) => r.trace.tokens);
  const cost = (tok: number) => (tok / 1_000_000) * INPUT_USD_PER_MTOK;

  /** Median over the PRs where the metric was scoreable at all. */
  const medianOf = (pick: (r: PrResult) => number | null): number | null => {
    const xs = rows.map(pick).filter((x): x is number => x !== null);
    return xs.length === 0 ? null : median(xs);
  };

  // Where trace-mcp did not pay off. Three distinct failure modes, reported
  // separately so the docs page cannot quietly merge them:
  //   truncated  — the budget dropped a changed symbol the baseline would show
  //   costlier   — the minimal context cost more than loading the files outright
  //   marginal   — under 50% saved, so the index barely earned its keep
  const lossReason = (r: PrResult): string | null => {
    if ((r.trace.changed_symbol_readable ?? 1) < (r.baseline.changed_symbol_readable ?? 1)) {
      return 'truncated';
    }
    if (r.trace.tokens >= r.baseline.tokens) return 'costlier';
    if (r.savings_pct < 50) return 'marginal';
    return null;
  };
  const losses = rows
    .map((r) => ({ r, reason: lossReason(r) }))
    .filter((x): x is { r: PrResult; reason: string } => x.reason !== null)
    .map(({ r, reason }) => ({
      reason,
      url: r.url,
      changed_files: r.changed_files,
      changed_symbols: r.changed_symbols,
      baseline_tokens: r.baseline.tokens,
      trace_tokens: r.trace.tokens,
      savings_pct: r.savings_pct,
      baseline_changed_symbol_readable: r.baseline.changed_symbol_readable,
      trace_changed_symbol_readable: r.trace.changed_symbol_readable,
    }))
    .sort((a, b) => a.savings_pct - b.savings_pct);

  const results = {
    generated_at: new Date().toISOString(),
    // TRA-920: the build this ran at travels with the number to every surface.
    measured_build: measuredBuild(),
    model_for_pricing: MODEL_NAME,
    input_usd_per_mtok: INPUT_USD_PER_MTOK,
    context_window: CONTEXT_WINDOW,
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    pr_count: rows.length,
    skipped,
    aggregates: {
      baseline_tokens: { median: median(b), p90: percentile(b, 90), max: Math.max(0, ...b) },
      trace_tokens: { median: median(t), p90: percentile(t, 90), max: Math.max(0, ...t) },
      median_savings_pct: median(rows.map((r) => r.savings_pct)),
      baseline_cost_usd: { median: cost(median(b)), p90: cost(percentile(b, 90)) },
      trace_cost_usd: { median: cost(median(t)), p90: cost(percentile(t, 90)) },
      baseline_overflow_rate:
        rows.filter((r) => r.baseline.tokens > CONTEXT_WINDOW).length / Math.max(1, rows.length),
      trace_overflow_rate:
        rows.filter((r) => r.trace.tokens > CONTEXT_WINDOW).length / Math.max(1, rows.length),
      baseline_changed_symbol_readable: medianOf((r) => r.baseline.changed_symbol_readable),
      trace_changed_symbol_readable: medianOf((r) => r.trace.changed_symbol_readable),
      baseline_dependent_readable: medianOf((r) => r.baseline.dependent_readable),
      trace_dependent_readable: medianOf((r) => r.trace.dependent_readable),
      baseline_dependent_pointed: medianOf((r) => r.baseline.dependent_pointed),
      trace_dependent_pointed: medianOf((r) => r.trace.dependent_pointed),
      median_index_ms: median(rows.map((r) => r.index_ms)),
    },
    losses,
    rows,
  };

  fs.writeFileSync(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);

  // Same discipline as docs/_data/counts.yml: the docs page renders these and
  // never hand-types a number. Preformatted so Liquid does no arithmetic.
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  fs.writeFileSync(
    DOCS_DATA_PATH,
    `${JSON.stringify(
      {
        generated_at: results.generated_at,
        measured_build: results.measured_build,
        pr_count: results.pr_count,
        repo_count: new Set(rows.map((r) => r.repo)).size,
        skipped_count: skipped.length,
        model: MODEL_NAME,
        input_usd_per_mtok: INPUT_USD_PER_MTOK,
        baseline_median_tokens: Math.round(results.aggregates.baseline_tokens.median),
        baseline_p90_tokens: Math.round(results.aggregates.baseline_tokens.p90),
        baseline_max_tokens: results.aggregates.baseline_tokens.max,
        trace_median_tokens: Math.round(results.aggregates.trace_tokens.median),
        trace_p90_tokens: Math.round(results.aggregates.trace_tokens.p90),
        trace_max_tokens: results.aggregates.trace_tokens.max,
        median_savings_pct: results.aggregates.median_savings_pct.toFixed(1),
        baseline_median_cost: results.aggregates.baseline_cost_usd.median.toFixed(4),
        baseline_p90_cost: results.aggregates.baseline_cost_usd.p90.toFixed(4),
        trace_median_cost: results.aggregates.trace_cost_usd.median.toFixed(4),
        trace_p90_cost: results.aggregates.trace_cost_usd.p90.toFixed(4),
        baseline_dependent_readable: pct(results.aggregates.baseline_dependent_readable),
        trace_dependent_readable: pct(results.aggregates.trace_dependent_readable),
        baseline_dependent_pointed: pct(results.aggregates.baseline_dependent_pointed),
        trace_dependent_pointed: pct(results.aggregates.trace_dependent_pointed),
        baseline_changed_symbol_readable: pct(results.aggregates.baseline_changed_symbol_readable),
        trace_changed_symbol_readable: pct(results.aggregates.trace_changed_symbol_readable),
        median_index_ms: Math.round(results.aggregates.median_index_ms),
        loss_count: losses.length,
        losses: losses.map((l) => ({
          ...l,
          savings_pct: l.savings_pct.toFixed(1),
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\n${rows.length} PRs measured, ${skipped.length} skipped → ${RESULTS_PATH}`);
  console.log(
    `median ${results.aggregates.baseline_tokens.median} → ${results.aggregates.trace_tokens.median} tokens ` +
      `(${results.aggregates.median_savings_pct.toFixed(1)}% saved), ${losses.length} PRs where trace-mcp did not pay off`,
  );
}

// Exported for tests — the scoring helpers are the only non-trivial logic here.
export { addSpan, covers, median, percentile, type Spans };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes('--mine')) {
    mine();
  } else {
    const li = argv.indexOf('--limit');
    const limit = li >= 0 ? Number(argv[li + 1]) : undefined;
    await run(limit);
  }
}
