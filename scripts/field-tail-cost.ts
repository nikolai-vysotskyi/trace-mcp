#!/usr/bin/env tsx
/**
 * TRA-1159: what the tools the harness never priced actually cost.
 *
 * `scripts/bench-response-tokens.ts` prices 24 tools — 97.2% of recorded call
 * volume — because each one needs arguments a human wrote. The other 74 tools
 * this machine has called are 2.2% of the volume and 0% of the measurement, and
 * "the rest is small" is an assumption, not a number: a tool nobody prices can
 * return anything.
 *
 * No arguments are recorded anywhere, so those tools cannot be re-called. But
 * `~/.trace/analytics.db` keeps `output_size_chars` for every mined call, which
 * is the response itself — the same source `field-response-distribution.mjs`
 * uses to cross-check a single tool. Chars become o200k tokens at the median
 * chars->token ratio of the 24 tools the harness *did* measure on the wire
 * (they span 0.220 to 0.368; the median is the estimator, and the spread is
 * published next to the result so the reader can size the error).
 *
 * This is a weaker instrument than the harness — one machine's calls, an
 * imputed ratio — and it is the only one that reaches the tail at all. It does
 * not replace a harness row for any tool; it prices the block as a block.
 *
 *   npx tsx scripts/field-tail-cost.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { NO_BASELINE_TOOLS, rawCostFor } from '../src/savings.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(REPO, 'docs/_data/response_tokens_tail.json');

const bench = JSON.parse(readFileSync(join(REPO, 'docs/perf/response-tokens.json'), 'utf8')) as {
  measured_at: string;
  measured_build: { version: string; commit: string };
  rows: Array<{ tool: string; chars: number; real: number }>;
};
const published = JSON.parse(
  readFileSync(join(REPO, 'docs/_data/response_tokens.json'), 'utf8'),
) as {
  rows: Array<{ tool: string }>;
  overhead_rows: Array<{ tool: string }>;
  baseline_tokens: number;
  measured_tokens: number;
  overhead_tokens: number;
  calls_weighted: number;
  overhead_calls: number;
};

const ratios = bench.rows
  .filter((r) => r.chars > 0)
  .map((r) => r.real / r.chars)
  .sort((a, b) => a - b);
const ratio = ratios[Math.floor(ratios.length / 2)];

const measured = new Set([
  ...published.rows.map((r) => r.tool),
  ...published.overhead_rows.map((r) => r.tool),
]);

interface TailEntry {
  tool: string;
  calls: number;
  field_calls: number;
  mean_chars: number | null;
}

const snapshotPath = join(REPO, 'benchmarks/response-tokens/tail-snapshot.json');
let tailTools: TailEntry[] = [];

if (process.argv.includes('--live')) {
  const Database = (await import('better-sqlite3')).default;
  const store = JSON.parse(readFileSync(join(homedir(), '.trace/savings.json'), 'utf8')) as {
    per_tool: Record<string, number | { calls: number }>;
  };
  const db = new Database(join(homedir(), '.trace/analytics.db'), { readonly: true });
  const fieldMap = new Map<string, { calls: number; meanChars: number }>();
  for (const r of db
    .prepare(
      `SELECT tool_short_name AS tool, COUNT(*) AS n, AVG(output_size_chars) AS chars
         FROM tool_calls WHERE is_error = 0 AND output_size_chars > 0 GROUP BY 1`,
    )
    .all() as Array<{ tool: string; n: number; chars: number }>) {
    fieldMap.set(r.tool, { calls: r.n, meanChars: r.chars });
  }
  for (const [tool, rec] of Object.entries(store.per_tool)) {
    if (measured.has(tool)) continue;
    const calls = typeof rec === 'number' ? rec : rec.calls;
    const f = fieldMap.get(tool);
    tailTools.push({
      tool,
      calls,
      field_calls: f ? f.calls : 0,
      mean_chars: f ? Math.round(f.meanChars * 10) / 10 : null,
    });
  }
} else {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
    tools: TailEntry[];
  };
  tailTools = snapshot.tools.filter((t) => !measured.has(t.tool));
}

interface TailRow {
  tool: string;
  calls: number;
  field_calls: number;
  per_call: number;
  baseline_per_call: number;
  measured_over_baseline: number | null;
  measured_tokens: number;
  no_baseline: boolean;
}

const rows: TailRow[] = [];
const unpriced: Array<{ tool: string; calls: number }> = [];

for (const t of tailTools) {
  if (t.mean_chars === null || t.field_calls === 0) {
    unpriced.push({ tool: t.tool, calls: t.calls });
    continue;
  }
  const perCall = Math.round(t.mean_chars * ratio);
  const baseline = rawCostFor(t.tool);
  rows.push({
    tool: t.tool,
    calls: t.calls,
    field_calls: t.field_calls,
    per_call: perCall,
    baseline_per_call: baseline,
    measured_over_baseline: baseline > 0 ? Number((perCall / baseline).toFixed(2)) : null,
    measured_tokens: perCall * t.calls,
    no_baseline: NO_BASELINE_TOOLS.has(t.tool),
  });
}
rows.sort((a, b) => b.measured_tokens - a.measured_tokens);

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const tailCalls = sum(rows.map((r) => r.calls)) + sum(unpriced.map((u) => u.calls));
const overhead = rows.filter((r) => r.no_baseline);
const scored = rows.filter((r) => !r.no_baseline);
const tailMeasured = sum(scored.map((r) => r.measured_tokens));
const tailBaseline = sum(scored.map((r) => r.baseline_per_call * r.calls));
const tailOverheadTokens = sum(overhead.map((r) => r.measured_tokens));

const headB = published.baseline_tokens;
const headM = published.measured_tokens;
const headOH = published.overhead_tokens;
const headCalls = published.calls_weighted + (published.overhead_calls ?? 0);
const totalCalls = headCalls + tailCalls;
const pricedCalls = headCalls + sum(rows.map((r) => r.calls));

const pct = (m: number, b: number): number => Number((100 * (1 - m / b)).toFixed(1));

const out = {
  _comment:
    'Generated by scripts/field-tail-cost.ts (TRA-1159) — do not edit by hand. Prices the tools bench-response-tokens.ts never measured, from recorded response sizes on one machine. Weaker than the harness and the only instrument that reaches the tail.',
  generated_at: new Date().toISOString(),
  measured_build: bench.measured_build,
  source:
    'benchmarks/response-tokens/tail-snapshot.json (~/.trace/analytics.db + ~/.trace/savings.json, one machine)',
  chars_to_tokens: {
    ratio: Number(ratio.toFixed(4)),
    from: `median of the ${bench.rows.length} harness-measured tools in docs/perf/response-tokens.json`,
    min: Number(ratios[0].toFixed(4)),
    max: Number(ratios[ratios.length - 1].toFixed(4)),
  },
  tail_tools: rows.length + unpriced.length,
  tail_calls: tailCalls,
  priced_calls: sum(rows.map((r) => r.calls)),
  unpriced_calls: sum(unpriced.map((u) => u.calls)),
  unpriced_tools: unpriced.length,
  coverage_pct_before: Number(((100 * headCalls) / totalCalls).toFixed(1)),
  coverage_pct_after: Number(((100 * pricedCalls) / totalCalls).toFixed(1)),
  tail_measured_tokens: tailMeasured,
  tail_baseline_tokens: tailBaseline,
  tail_measured_over_baseline: Number((tailMeasured / tailBaseline).toFixed(2)),
  tail_overhead_calls: sum(overhead.map((r) => r.calls)),
  tail_overhead_tokens: tailOverheadTokens,
  headline: {
    reduction_pct_head_only: pct(headM, headB),
    reduction_pct_with_tail: pct(headM + tailMeasured, headB + tailBaseline),
    reduction_pct_incl_overhead_head_only: pct(headM + headOH, headB),
    reduction_pct_incl_overhead_with_tail: pct(
      headM + headOH + tailMeasured + tailOverheadTokens,
      headB + tailBaseline,
    ),
  },
  rows,
  unpriced: unpriced.sort((a, b) => b.calls - a.calls),
};

writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ ...out, rows: rows.slice(0, 10), unpriced: undefined }, null, 2));
console.log(`\nwrote ${OUT}`);
