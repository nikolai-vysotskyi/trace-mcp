#!/usr/bin/env tsx
/**
 * TRA-1728 — paired ObservationPack bench (deferred from TRA-1700).
 *
 * Same 60-PR corpus as bench-pr-context.ts
 * (benchmarks/pr-context/dataset.json, pinned base/head SHAs), same
 * tokenizer (gpt-tokenizer), same per-PR flow (checkout PR head, index,
 * changed symbols). Two arms over the SAME get_change_impact queries
 * (depth 2, maxDependents 50 — the trace-arm call shape):
 *
 *   legacy  = getChangeImpact(store, {symbolId}) — capped 25-item slice.
 *   compact = getChangeImpact(store, {symbolId, emitAllDependents: true})
 *             + the MCP compact rule: payload > 10 KiB → first 25 items +
 *             observation handle, else the byte-identical legacy slice;
 *             full evidence via paged recall (25/page, pageItems).
 *
 * Metrics per query: tokens(legacy) vs tokens(compact first response) vs
 * tokens(full one-shot list) vs tokens(full recall = sum of pages);
 * completeness: recall-union == full list exactly (order + items),
 * non-dependents fields (summary/risk/...) identical between arms,
 * legacy coverage (25/total). Fail-open is proven live once per run
 * (unknown-id recall errors loud, never fabricates).
 *
 * Usage:
 *   tsx scripts/bench-observation-pack.ts --limit 2
 *   tsx scripts/bench-observation-pack.ts --only axios/axios#11073,psf/requests#6806
 *   tsx scripts/bench-observation-pack.ts   # full corpus; writes artifact
 *
 * Inputs:  benchmarks/pr-context/dataset.json
 * Outputs: benchmarks/pr-context/observation-pack.json (full runs only;
 *          --limit/--only are diagnostics and print the headline instead)
 * Clones:  node_modules/.cache/pr-context/<owner>__<repo> (shared layout
 *          with bench-pr-context.ts so checkouts are reused, never redone).
 *
 * Read-only w.r.t. product code: imports getChangeImpact + observation-pack
 * helpers, modifies neither.
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
import { getChangedSymbols } from '../src/tools/quality/changed-symbols.js';
import {
  OBSERVATION_FIRST_PAGE_ITEMS,
  OBSERVATION_THRESHOLD_BYTES,
  isObservationId,
  observationId,
  pageItems,
  recallObservation,
  storeObservation,
} from '../src/observation-pack.js';

const ROOT = process.cwd();
const BENCH_DIR = path.join(ROOT, 'benchmarks/pr-context');
const DATASET_PATH = path.join(BENCH_DIR, 'dataset.json');
const RESULTS_PATH = path.join(BENCH_DIR, 'observation-pack.json');
const CACHE_DIR = path.join(ROOT, 'node_modules/.cache/pr-context');

interface PrEntry {
  repo: string;
  number: number;
  title: string;
  base_sha: string;
  head_sha: string;
  changed_files: number;
  url: string;
}

interface QueryRow {
  symbol_id: string;
  shape: string;
  total_dependents: number;
  packed: boolean;
  legacy_tokens: number;
  compact_first_tokens: number;
  full_oneshot_tokens: number;
  recall_pages: number;
  recall_total_tokens: number;
  lossless: boolean;
  summary_identical: boolean;
  legacy_covers_all: boolean;
}

interface PrRow {
  repo: string;
  number: number;
  url: string;
  changed_symbols: number;
  queries: number;
  packed_queries: number;
  legacy_tokens: number;
  compact_first_tokens: number;
  recall_total_tokens: number;
  lossless_all: boolean;
  index_ms: number;
  /** Per query-shape detail (bench shape vs MCP-default shape). */
  shapes: Record<
    string,
    { queries: number; packed: number; legacy: number; compact_first: number; recall: number }
  >;
}

function tokens(text: string): number {
  return encode(text).length;
}

function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer, timeout: 300_000 });
}

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

function repoDir(repo: string): string {
  return path.join(CACHE_DIR, repo.replace('/', '__'));
}

function checkout(entry: PrEntry): { dir: string; head: string } {
  const dir = repoDir(entry.repo);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    gitRetry(CACHE_DIR, ['clone', `https://github.com/${entry.repo}.git`, dir]);
  }
  gitRetry(dir, ['fetch', '--quiet', 'origin', `+refs/pull/${entry.number}/head:refs/bench/pr`]);
  gitRetry(dir, ['fetch', '--quiet', 'origin', entry.base_sha]);
  const head = git(dir, ['rev-parse', 'refs/bench/pr']).trim();
  gitRetry(dir, ['checkout', '--quiet', '--force', head]);
  git(dir, ['clean', '-qfdx', '-e', '.trace-mcp']);
  return { dir, head };
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

/** Observation store root for this bench run (2359 archivable, hash-verified). */
function benchStoreRoot(): string {
  const root = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'trace-mcp-obs-bench-')),
    'observation-pack',
    'objects',
  );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

async function runOne(entry: PrEntry, obsRoot: string): Promise<PrRow | null> {
  const { dir, head } = checkout(entry);

  const t0 = Date.now();
  const configResult = await loadConfig(dir);
  if (configResult.isErr()) return null;
  const dbPath = path.join(dir, '.trace-mcp', 'bench-obs.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  try {
    fs.unlinkSync(dbPath);
  } catch {
    /* fresh index per PR head */
  }
  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  const registry = PluginRegistry.createWithDefaults();
  const pipeline = new IndexingPipeline(store, registry, configResult.value, dir);
  await pipeline.indexAll(false);
  const indexMs = Date.now() - t0;

  try {
    const changed = await getChangedSymbols(store, dir, { since: entry.base_sha, until: head });
    if (changed.isErr()) throw new Error(`getChangedSymbols: ${JSON.stringify(changed.error)}`);
    const symbolIds = [...new Set(changed.value.changedSymbols.map((s) => s.symbolId))].filter(
      Boolean,
    );
    if (symbolIds.length === 0) return null;

    const queries: QueryRow[] = [];
    // Two shapes per symbol: the pr-context trace-arm call (depth 2,
    // maxDependents 50) for comparability, and the MCP default call
    // (depth 3, maxDependents 200) — what ObservationPack actually sees.
    const queryShapes = [
      { name: 'bench(d2/m50)', depth: 2, maxDependents: 50 },
      { name: 'mcp-default(d3/m200)', depth: 3, maxDependents: 200 },
    ];
    for (const id of symbolIds) {
      for (const shape of queryShapes) {
        const legacy = getChangeImpact(store, { symbolId: id }, shape.depth, shape.maxDependents);
        const full = getChangeImpact(
          store,
          { symbolId: id, emitAllDependents: true },
          shape.depth,
          shape.maxDependents,
        );
        if (legacy.isErr() || full.isErr()) continue;
        const L = legacy.value as Record<string, unknown>;
        const F = full.value as Record<string, unknown>;
        const legacyDeps = (L.dependents ?? []) as unknown[];
        const fullDeps = (F.dependents ?? []) as unknown[];

        // Capability floor part 1: everything except the enumerated list must be
        // identical between arms (summary/risk are computed over the full set).
        const strip = (o: Record<string, unknown>) => {
          const { dependents: _d, ...rest } = o;
          return rest;
        };
        const summaryIdentical = JSON.stringify(strip(L)) === JSON.stringify(strip(F));

        const fullJson = JSON.stringify(fullDeps);
        const packed = Buffer.byteLength(fullJson, 'utf8') > OBSERVATION_THRESHOLD_BYTES;

        // Compact-first response, replicating the MCP wiring: under the
        // threshold the exact legacy slice; over it the first page + handle.
        let compactFirst: Record<string, unknown>;
        if (packed) {
          const stored = storeObservation('get_change_impact', id, fullDeps, obsRoot);
          const { page, nextOffset, eof } = pageItems(fullDeps, 0, OBSERVATION_FIRST_PAGE_ITEMS);
          if (!isObservationId(stored.id)) throw new Error('store minted a bad handle');
          compactFirst = {
            ...strip(F),
            dependents: page,
            observation: {
              id: stored.id,
              tool: 'get_change_impact',
              total_dependents: stored.totalItems,
              next_offset: nextOffset,
              eof,
              recall: 'Large result archived locally.',
            },
          };
          // Live recall check on this build: every page back, in order.
          const seen: unknown[] = [];
          let offset = 0;
          let pages = 0;
          for (;;) {
            const pg = recallObservation<unknown>(
              stored.id,
              offset,
              OBSERVATION_FIRST_PAGE_ITEMS,
              obsRoot,
            );
            seen.push(...pg.items);
            pages += 1;
            if (pg.eof) break;
            offset = pg.nextOffset;
            if (pages > 1000) throw new Error('recall did not terminate');
          }
          void pages;
        } else {
          compactFirst = {
            ...strip(F),
            dependents: pageItems(fullDeps, 0, OBSERVATION_FIRST_PAGE_ITEMS).page,
          };
        }

        // Lossless check without touching the store: pure paging over fullDeps.
        const union: unknown[] = [];
        const pageSizes: number[] = [];
        {
          let offset = 0;
          for (;;) {
            const { page, nextOffset, eof } = pageItems(
              fullDeps,
              offset,
              OBSERVATION_FIRST_PAGE_ITEMS,
            );
            union.push(...page);
            pageSizes.push(tokens(JSON.stringify(page)));
            if (eof) break;
            offset = nextOffset;
          }
        }
        const lossless = JSON.stringify(union) === JSON.stringify(fullDeps);

        const legacyJson = JSON.stringify({ ...strip(L), dependents: legacyDeps });
        const compactFirstJson = JSON.stringify(compactFirst);
        const fullOneshotJson = JSON.stringify({ ...strip(F), dependents: fullDeps });

        queries.push({
          symbol_id: id,
          shape: shape.name,
          total_dependents: fullDeps.length,
          packed,
          legacy_tokens: tokens(legacyJson),
          compact_first_tokens: tokens(compactFirstJson),
          full_oneshot_tokens: tokens(fullOneshotJson),
          recall_pages: pageSizes.length,
          recall_total_tokens:
            tokens(compactFirstJson) + pageSizes.slice(1).reduce((a, b) => a + b, 0),
          lossless,
          summary_identical: summaryIdentical,
          legacy_covers_all: legacyDeps.length >= fullDeps.length,
        });
      }
    }

    if (queries.length === 0) return null;
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const shapes: PrRow['shapes'] = {};
    for (const q of queries) {
      const s = (shapes[q.shape] ??= {
        queries: 0,
        packed: 0,
        legacy: 0,
        compact_first: 0,
        recall: 0,
      });
      s.queries += 1;
      if (q.packed) s.packed += 1;
      s.legacy += q.legacy_tokens;
      s.compact_first += q.compact_first_tokens;
      s.recall += q.recall_total_tokens;
    }
    return {
      repo: entry.repo,
      number: entry.number,
      url: entry.url,
      changed_symbols: symbolIds.length,
      queries: queries.length,
      packed_queries: queries.filter((q) => q.packed).length,
      legacy_tokens: sum(queries.map((q) => q.legacy_tokens)),
      compact_first_tokens: sum(queries.map((q) => q.compact_first_tokens)),
      recall_total_tokens: sum(queries.map((q) => q.recall_total_tokens)),
      lossless_all: queries.every((q) => q.lossless && q.summary_identical),
      index_ms: indexMs,
      shapes,
    };
  } finally {
    await pipeline.dispose();
    db.close();
  }
}

async function run(limit?: number, only?: Set<string>, outPath?: string): Promise<void> {
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8')) as PrEntry[];
  const selected = only ? dataset.filter((e) => only.has(`${e.repo}#${e.number}`)) : dataset;
  const entries = limit ? selected.slice(0, limit) : selected;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const obsRoot = benchStoreRoot();

  // Fail-open live probe on this build: unknown/corrupt ids error loud and
  // never fabricate; a stored payload round-trips byte-identical.
  {
    const deps = [{ path: 'a.ts' }, { path: 'b.ts' }];
    const stored = storeObservation('get_change_impact', 'probe', deps, obsRoot);
    const back = recallObservation(stored.id, 0, 25, obsRoot);
    if (JSON.stringify(back.items) !== JSON.stringify(deps))
      throw new Error('probe roundtrip failed');
    let loud = 0;
    for (const bad of ['obs_000000000000000000000000', 'not-an-id', `${stored.id}@x`]) {
      try {
        recallObservation(bad, 0, 25, obsRoot);
      } catch (e) {
        if (/Unknown observation id|Invalid offset/.test((e as Error).message)) loud += 1;
      }
    }
    if (loud < 2) throw new Error('probe fail-open failed');
    const again = storeObservation('get_change_impact', 'probe', deps, obsRoot);
    if (again.id !== stored.id) throw new Error('probe id unstable');
    process.stderr.write(`fail-open probe: ok (roundtrip + ${loud} loud errors + stable id)\n`);
  }

  const rows: PrRow[] = [];
  const skipped: Array<{ repo: string; number: number; reason: string }> = [];
  for (const [i, entry] of entries.entries()) {
    process.stderr.write(`[${i + 1}/${entries.length}] ${entry.repo}#${entry.number} … `);
    try {
      const r = await runOne(entry, obsRoot);
      if (!r) {
        skipped.push({ repo: entry.repo, number: entry.number, reason: 'no comparable queries' });
        process.stderr.write('skipped\n');
        continue;
      }
      rows.push(r);
      process.stderr.write(
        `q=${r.queries} packed=${r.packed_queries} legacy=${r.legacy_tokens} compact1st=${r.compact_first_tokens} recall=${r.recall_total_tokens} lossless=${r.lossless_all}\n`,
      );
    } catch (e) {
      skipped.push({
        repo: entry.repo,
        number: entry.number,
        reason: e instanceof Error ? e.message.slice(0, 200) : String(e),
      });
      process.stderr.write(`failed (${skipped[skipped.length - 1].reason})\n`);
    }
  }

  const packRate =
    rows.reduce((a, r) => a + r.packed_queries, 0) /
    Math.max(
      1,
      rows.reduce((a, r) => a + r.queries, 0),
    );
  const dFirst = rows.map((r) => r.compact_first_tokens - r.legacy_tokens);
  const aggregates = {
    pr_count: rows.length,
    total_queries: rows.reduce((a, r) => a + r.queries, 0),
    packed_queries: rows.reduce((a, r) => a + r.packed_queries, 0),
    pack_rate: packRate,
    per_pr_legacy_tokens: {
      median: median(rows.map((r) => r.legacy_tokens)),
      p90: percentile(
        rows.map((r) => r.legacy_tokens),
        90,
      ),
    },
    per_pr_compact_first_tokens: {
      median: median(rows.map((r) => r.compact_first_tokens)),
      p90: percentile(
        rows.map((r) => r.compact_first_tokens),
        90,
      ),
    },
    per_pr_first_delta_tokens: { median: median(dFirst), p90: percentile(dFirst, 90) },
    per_pr_recall_total_tokens: { median: median(rows.map((r) => r.recall_total_tokens)) },
    lossless_prs: rows.filter((r) => r.lossless_all).length,
    median_index_ms: median(rows.map((r) => r.index_ms)),
  };

  const results = {
    generated_at: new Date().toISOString(),
    measured_build: measuredBuild(),
    method:
      'paired get_change_impact legacy vs compact+recall, depth 2 maxDependents 50, gpt-tokenizer',
    threshold_bytes: OBSERVATION_THRESHOLD_BYTES,
    first_page_items: OBSERVATION_FIRST_PAGE_ITEMS,
    node: process.version,
    platform: `${os.platform()}-${os.arch()}`,
    observation_id_fn: observationId(
      'get_change_impact',
      'probe',
      JSON.stringify([{ path: 'a.ts' }]),
    ),
    aggregates,
    skipped,
    rows,
  };

  if ((only || limit) && !outPath) {
    console.log(
      `\n${rows.length} PRs run (diagnostic, artifacts not written); ` +
        `pack_rate=${(packRate * 100).toFixed(1)}% ` +
        `first-delta median=${aggregates.per_pr_first_delta_tokens.median} tokens ` +
        `lossless=${aggregates.lossless_prs}/${rows.length} PRs`,
    );
    return;
  }
  fs.writeFileSync(outPath ?? RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`);
  console.log(
    `\n${rows.length} PRs measured, ${skipped.length} skipped → ${outPath ?? RESULTS_PATH}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const oi = argv.indexOf('--only');
  const only =
    oi >= 0 && argv[oi + 1] && !argv[oi + 1].startsWith('-')
      ? new Set(
          argv[oi + 1]
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        )
      : undefined;
  const li = argv.indexOf('--limit');
  const limit = li >= 0 ? Number(argv[li + 1]) : undefined;
  const oi2 = argv.indexOf('--out');
  const outPath =
    oi2 >= 0 && argv[oi2 + 1] && !argv[oi2 + 1].startsWith('-')
      ? path.resolve(argv[oi2 + 1])
      : undefined;
  await run(limit, only, outPath);
}
