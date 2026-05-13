/**
 * BenchmarkRunner — the vertical slice of plan-cognee-P04.
 *
 * Responsibilities:
 *   1. Open the indexed Store for a project root.
 *   2. For each case in the dataset, call `search(...)` with the case's
 *      query + filters.
 *   3. Capture the top-K results, score precision@K and reciprocal rank.
 *   4. Roll up per-metric statistics and emit a `BenchmarkReport`.
 *
 * Out of scope (P04 v2):
 *   - Pluggable retrievers
 *   - Fixture projects (this slice runs against the host project)
 *   - Baseline diffing
 *   - Latency-bounded execution
 *   - Telemetry emission (TODO once src/telemetry/ public surface lands)
 */

import { initializeDatabase } from '../db/schema.js';
import { Store } from '../db/store.js';
import { search } from '../tools/navigation/navigation.js';
import { precisionAtK } from './metrics/precision-at-k.js';
import { reciprocalRank } from './metrics/mrr.js';
import type {
  BenchmarkCase,
  BenchmarkDataset,
  BenchmarkReport,
  CaseResult,
  CaseResultItem,
  MetricResult,
  MetricRollup,
} from './types.js';

export interface RunOptions {
  /** Path to the SQLite index for the project the dataset targets. */
  dbPath: string;
  /** Top-K depth for precision@K. Defaults to 5. */
  k?: number;
}

export class BenchmarkRunner {
  private readonly dataset: BenchmarkDataset;
  private readonly k: number;
  private readonly dbPath: string;

  constructor(dataset: BenchmarkDataset, options: RunOptions) {
    if (options.k !== undefined && options.k < 1) {
      throw new Error(`k must be >= 1; got ${options.k}`);
    }
    this.dataset = dataset;
    this.k = options.k ?? 5;
    this.dbPath = options.dbPath;
  }

  async run(): Promise<BenchmarkReport> {
    const startedAt = Date.now();
    const db = initializeDatabase(this.dbPath);
    const store = new Store(db);
    const caseResults: CaseResult[] = [];

    try {
      for (const c of this.dataset.cases) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design (slice scope)
        const result = await this.runCase(store, c);
        caseResults.push(result);
      }
    } finally {
      db.close();
    }

    const rollup = this.rollup(caseResults);
    return {
      dataset_id: this.dataset.id,
      dataset_description: this.dataset.description,
      ran_at: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt,
      k: this.k,
      total_cases: caseResults.length,
      cases: caseResults,
      rollup,
    };
  }

  private async runCase(store: Store, c: BenchmarkCase): Promise<CaseResult> {
    const t0 = Date.now();
    const searchResult = await search(
      store,
      c.query,
      c.filters
        ? {
            kind: c.filters.kind,
            language: c.filters.language,
            filePattern: c.filters.filePattern,
          }
        : undefined,
      this.k,
      0,
    );
    const latency_ms = Date.now() - t0;

    const results: CaseResultItem[] = searchResult.items.slice(0, this.k).map((it, idx) => ({
      rank: idx + 1,
      symbol_id: it.symbol.symbol_id,
      name: it.symbol.name,
      kind: it.symbol.kind,
      file: it.file.path,
      score: it.score,
    }));

    const pAtK = precisionAtK({
      results,
      expected_files: c.expected_files,
      k: this.k,
    });
    const rr = reciprocalRank({
      results,
      expected_files: c.expected_files,
    });

    const metrics: MetricResult[] = [
      pAtK,
      { name: 'mrr', value: rr.value, details: rr.details },
      {
        name: 'first_hit_rank',
        // first_hit_rank metric: 0 if no hit, else the rank (kept as numeric
        // for rollup; per-case humans should look at the `first_hit_rank`
        // field on CaseResult).
        value: rr.first_hit_rank ?? 0,
        details: rr.first_hit_rank === null ? { hit: false } : { rank: rr.first_hit_rank },
      },
    ];

    return {
      case_id: c.id,
      query: c.query,
      expected_files: [...c.expected_files],
      results,
      metrics,
      latency_ms,
      first_hit_rank: rr.first_hit_rank,
    };
  }

  private rollup(cases: CaseResult[]): MetricRollup[] {
    if (cases.length === 0) return [];

    const groups = new Map<string, number[]>();
    for (const c of cases) {
      for (const m of c.metrics) {
        const arr = groups.get(m.name) ?? [];
        arr.push(m.value);
        groups.set(m.name, arr);
      }
    }

    const rollups: MetricRollup[] = [];
    for (const [metric, values] of groups) {
      // first_hit_rank rolls up over hits only — including misses (0) would
      // bias the mean rank toward zero, which is meaningless. Document the
      // exception inline.
      const filtered = metric === 'first_hit_rank' ? values.filter((v) => v > 0) : values;
      if (filtered.length === 0) {
        rollups.push({ metric, mean: 0, min: 0, max: 0, n: 0 });
        continue;
      }
      const sum = filtered.reduce((a, b) => a + b, 0);
      rollups.push({
        metric,
        mean: sum / filtered.length,
        min: Math.min(...filtered),
        max: Math.max(...filtered),
        n: filtered.length,
      });
    }

    // Stable ordering for deterministic snapshots.
    rollups.sort((a, b) => a.metric.localeCompare(b.metric));
    return rollups;
  }
}

/**
 * Render a `BenchmarkReport` as a human-readable Markdown report.
 *
 * Sections:
 *   - Header (dataset id, K, duration, total cases)
 *   - Rollup table
 *   - Per-case table
 *
 * The format is deliberately plain Markdown so it can be pasted into a
 * PR description or saved with `--output report.md`.
 */
export function formatReportMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`# Eval report — ${report.dataset_id}`);
  lines.push('');
  if (report.dataset_description) lines.push(`> ${report.dataset_description}`);
  lines.push('');
  lines.push(`- Ran at: ${report.ran_at}`);
  lines.push(`- Duration: ${report.duration_ms} ms`);
  lines.push(`- Top-K: ${report.k}`);
  lines.push(`- Cases: ${report.total_cases}`);
  lines.push('');

  lines.push('## Rollup');
  lines.push('');
  lines.push('| Metric | Mean | Min | Max | N |');
  lines.push('|---|---|---|---|---|');
  for (const r of report.rollup) {
    lines.push(
      `| ${r.metric} | ${formatNum(r.mean)} | ${formatNum(r.min)} | ${formatNum(r.max)} | ${r.n} |`,
    );
  }
  lines.push('');

  lines.push('## Per-case');
  lines.push('');
  lines.push(`| Case | Query | First hit rank | precision@${report.k} | Latency (ms) |`);
  lines.push('|---|---|---|---|---|');
  for (const c of report.cases) {
    const p = c.metrics.find((m) => m.name === `precision@${report.k}`);
    lines.push(
      `| ${c.case_id} | \`${truncate(c.query, 40)}\` | ${c.first_hit_rank ?? '—'} | ${formatNum(p?.value ?? 0)} | ${c.latency_ms} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
