/**
 * Benchmark Lab markdown export (TRA-1951).
 *
 * One function renders the table the UI copies and the docs pages quote:
 * per-arm tokens, calls, success and price, plus the provenance line that
 * makes the numbers checkable (run date, build version + commit, battery
 * hash). Docs pages must quote this output via `docs/_data`, never retype
 * the figures — see docs/vs/tokensave.md.
 */

import type { LabRun } from './runner.js';

const fmt = (n: number): string => n.toLocaleString('en-US');

function savingsCell(savings: number | null): string {
  if (savings === null) return '— (control)';
  const sign = savings > 0 ? '−' : '+';
  return `${sign}${Math.abs(savings).toFixed(1)}%`;
}

/**
 * Render a run as a markdown section ready to paste into docs. Numbers are
 * the run's own aggregates — this function computes no measurement, it only
 * formats.
 */
export function renderLabMarkdown(run: LabRun): string {
  const lines: string[] = [];
  lines.push(`## Benchmark Lab run ${run.run_id}`);
  lines.push('');
  lines.push(
    `Measured ${run.started_at.slice(0, 10)} at build ` +
      `${run.measured_build.version}@${run.measured_build.commit}` +
      `${run.measured_build.dirty ? ' (dirty tree)' : ''}, ` +
      `battery \`${run.battery.source}\` (${run.battery.fixture_count} fixtures, ` +
      `sha \`${run.battery.fixtures_sha}\`), ` +
      `priced at ${run.model.name} ($${run.model.input_usd_per_mtok}/Mtok input). ` +
      `Tokens are exact (o200k_base), not estimated.`,
  );
  lines.push('');
  lines.push('| arm | tokens | calls | success | vs file-reading | cost (USD) |');
  lines.push('|-----|-------:|------:|--------:|----------------:|----------:|');
  for (const a of run.aggregates) {
    lines.push(
      `| ${a.arm} | ${fmt(a.total_tokens)} | ${fmt(a.total_calls)} | ` +
        `${a.success_count}/${a.fixtures} | ${savingsCell(a.savings_vs_baseline_pct)} | ` +
        `$${a.cost_usd.toFixed(4)} |`,
    );
  }
  lines.push('');
  lines.push('| fixture | kind | ' + run.arms.map((a) => `${a} (tok/success)`).join(' | ') + ' |');
  lines.push('|---------|------|' + run.arms.map(() => '-----------------').join('|') + '|');
  for (const r of run.results) {
    const cells = run.arms.map((arm) => {
      const m = r.arms[arm];
      if (!m) return '—';
      return `${fmt(m.tokens)}/${m.success ? '✓' : '✗'}`;
    });
    lines.push(`| ${r.fixture_id} | ${r.kind} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push(
    `Re-run: open the Benchmark Lab tab in the trace-mcp app, pick the same arms, ` +
      `and compare against battery sha \`${run.battery.fixtures_sha}\`. ` +
      `Runs are stored under \`~/.trace/benchmark-runs/\` (see \`TRACE_MCP_DATA_DIR\`).`,
  );
  return `${lines.join('\n')}\n`;
}
