#!/usr/bin/env tsx
/**
 * Phase 5 replay harness — runs golden queries against the live `search` tool
 * and reports nDCG@10 / MRR / Recall@5. Compares to a saved baseline and
 * exits 1 when any metric regresses by more than the configured threshold.
 *
 * Usage:
 *   npx tsx scripts/replay-eval.ts                       # check vs baseline
 *   npx tsx scripts/replay-eval.ts --update-baseline     # write a new baseline
 *
 * Inputs:
 *   benchmarks/replay/queries.jsonc      — golden queries
 *   benchmarks/replay/baseline.json      — last known good metrics
 *
 * Output: prints per-query scores and a summary, then exits with code 0 (pass)
 * or 1 (regression detected / no baseline yet).
 */

import fs from 'node:fs';
import path from 'node:path';
import { initializeDatabase } from '../src/db/schema.js';
import { Store } from '../src/db/store.js';
import { getDbPath } from '../src/global.js';
import { findProjectRoot } from '../src/project-root.js';
import { getProject } from '../src/registry.js';
import {
  averageMetrics,
  evaluateRanking,
  type MetricsResult,
} from '../src/scoring/retrieval-metrics.js';
import { search } from '../src/tools/navigation/navigation.js';

interface QueryFixture {
  query: string;
  expected_match_substrings: string[];
}

interface Baseline {
  ndcg_at_k: number;
  mrr: number;
  recall_at_k: number;
  k: number;
  generated_at: string;
}

const ROOT = process.cwd();
const FIXTURE_PATH = path.join(ROOT, 'benchmarks/replay/queries.jsonc');
const BASELINE_PATH = path.join(ROOT, 'benchmarks/replay/baseline.json');
const REGRESSION_THRESHOLD = 0.05; // 5% drop on any metric is a fail

function loadFixtures(): QueryFixture[] {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  // Strip // comments — keep the JSONC tolerant.
  const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(stripped) as QueryFixture[];
}

function loadBaseline(): Baseline | null {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
}

function saveBaseline(metrics: MetricsResult): void {
  const data: Baseline = { ...metrics, generated_at: new Date().toISOString() };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Wrote baseline → ${BASELINE_PATH}`);
}

async function runQuery(store: Store, fixture: QueryFixture): Promise<MetricsResult> {
  const result = await search(store, fixture.query, undefined, 10);
  const ranked: string[] = result.items.map((item) => {
    return item.symbol.symbol_id ?? item.symbol.fqn ?? item.symbol.name ?? '';
  });

  // Build a "relevant" set: every result whose symbol_id or fqn contains any
  // expected substring is treated as relevant. Substring match keeps the
  // fixtures stable as the codebase grows.
  const substrings = fixture.expected_match_substrings.map((s) => s.toLowerCase());
  const relevant = new Set<string>();
  for (const rid of ranked) {
    const lower = rid.toLowerCase();
    if (substrings.some((sub) => lower.includes(sub))) relevant.add(rid);
  }

  // If we found no relevant results among top-10, treat as "all expected" so
  // that the score reflects a true miss rather than degenerating to 1.
  if (relevant.size === 0) {
    if (process.env.REPLAY_DEBUG) {
      console.log(
        `  [debug] zero match for "${fixture.query}"; top-5: ${ranked.slice(0, 5).join(', ')}`,
      );
    }
    return { ndcg_at_k: 0, mrr: 0, recall_at_k: 0, k: 10 };
  }
  return evaluateRanking(ranked, relevant, 10);
}

async function main(): Promise<number> {
  const updateBaseline = process.argv.includes('--update-baseline');
  const fixtures = loadFixtures();
  console.log(`Running ${fixtures.length} replay queries...\n`);

  const projectRoot = findProjectRoot(ROOT);
  const dbPath = getProject(projectRoot)?.dbPath ?? getDbPath(projectRoot);
  if (!fs.existsSync(dbPath)) {
    console.error(
      `No index database found at ${dbPath}. Run \`npx tsx src/cli.ts index\` first, then re-run the replay harness.`,
    );
    return 1;
  }
  const db = initializeDatabase(dbPath);
  const store = new Store(db);
  if (store.getStats().totalFiles === 0) {
    console.error(
      'Index database exists but contains no files. Run `npx tsx src/cli.ts index` to populate it.',
    );
    db.close();
    return 1;
  }

  const perQuery: { fixture: QueryFixture; metrics: MetricsResult }[] = [];
  for (const fixture of fixtures) {
    const metrics = await runQuery(store, fixture);
    perQuery.push({ fixture, metrics });
    console.log(
      `  ${fixture.query.padEnd(35)} | nDCG=${metrics.ndcg_at_k.toFixed(3)}  MRR=${metrics.mrr.toFixed(3)}  Recall=${metrics.recall_at_k.toFixed(3)}`,
    );
  }
  db.close();

  const aggregate = averageMetrics(perQuery.map((p) => p.metrics));
  console.log('\n--- Aggregate ---');
  console.log(`  nDCG@10  = ${aggregate.ndcg_at_k.toFixed(4)}`);
  console.log(`  MRR      = ${aggregate.mrr.toFixed(4)}`);
  console.log(`  Recall@5 = ${aggregate.recall_at_k.toFixed(4)}`);

  if (updateBaseline) {
    saveBaseline(aggregate);
    return 0;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error(
      `\nNo baseline found at ${BASELINE_PATH}. Run with --update-baseline once retrieval quality is acceptable.`,
    );
    return 1;
  }

  console.log('\n--- vs Baseline ---');
  let failed = false;
  const checks: Array<[keyof Pick<Baseline, 'ndcg_at_k' | 'mrr' | 'recall_at_k'>, string]> = [
    ['ndcg_at_k', 'nDCG@10'],
    ['mrr', 'MRR'],
    ['recall_at_k', 'Recall@5'],
  ];
  for (const [key, label] of checks) {
    const cur = aggregate[key];
    const base = baseline[key];
    const drop = base - cur;
    const dropPct = base > 0 ? drop / base : 0;
    const verdict = dropPct > REGRESSION_THRESHOLD ? '❌ REGRESSION' : '✅ OK';
    console.log(
      `  ${label.padEnd(8)}: cur=${cur.toFixed(4)}  base=${base.toFixed(4)}  Δ=${(-drop).toFixed(4)}  ${verdict}`,
    );
    if (dropPct > REGRESSION_THRESHOLD) failed = true;
  }

  if (failed) {
    console.error(
      `\nRetrieval quality regressed by more than ${(REGRESSION_THRESHOLD * 100).toFixed(0)}%. Investigate before merging.`,
    );
    return 1;
  }
  console.log('\n✅ All metrics within tolerance.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Replay harness failed:', err);
    process.exit(2);
  });
