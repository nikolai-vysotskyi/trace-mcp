#!/usr/bin/env node
/**
 * TRA-1951 — render the Benchmark Lab chart from the measured data file.
 *
 *   node scripts/gen-benchmark-lab-chart.mjs [data] [out]
 *
 * Reads `docs/_data/benchmark_lab.json` (written by `tsx scripts/bench-lab.ts`)
 * and draws one horizontal bar per arm: exact tokens on a linear scale, with
 * the success rate beside each value. No hand-set numbers anywhere — the SVG
 * is a pure function of the run it cites, so re-running the battery and this
 * script refreshes the figure without an editing pass.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataPath = path.resolve(
  process.argv[2] ?? path.join(REPO, 'docs', '_data', 'benchmark_lab.json'),
);
const outPath = path.resolve(
  process.argv[3] ?? path.join(REPO, 'docs', 'images', 'benchmark-lab-tokens.svg'),
);

const run = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
const arms = run.arms;
if (!Array.isArray(arms) || arms.length === 0) throw new Error(`no arms in ${dataPath}`);

const fmtInt = (n) => n.toLocaleString('en-US');
const maxTokens = Math.max(...arms.map((a) => a.total_tokens));

const W = 720;
const ROW_H = 64;
const PAD_TOP = 16;
const LABEL_W = 190;
const BAR_MAX = W - LABEL_W - 170;
const H = PAD_TOP + arms.length * ROW_H + 44;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const rows = arms
  .map((a, i) => {
    const y = PAD_TOP + i * ROW_H;
    const w = Math.max(2, Math.round((a.total_tokens / maxTokens) * BAR_MAX));
    const savings =
      a.savings_vs_baseline_pct === null || a.savings_vs_baseline_pct === undefined
        ? 'control'
        : `${a.savings_vs_baseline_pct > 0 ? '−' : '+'}${Math.abs(a.savings_vs_baseline_pct).toFixed(1)}% vs control`;
    return [
      `  <text x="0" y="${y + 22}" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="600" fill="#1d1d1f">${esc(a.arm)}</text>`,
      `  <text x="0" y="${y + 42}" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#6e6e73">${a.success_count}/${a.fixtures} fixtures · ${a.total_calls} calls</text>`,
      `  <rect x="${LABEL_W}" y="${y + 6}" width="${w}" height="26" rx="4" fill="${i === 0 ? '#8e8e93' : '#0a84ff'}"/>`,
      `  <text x="${LABEL_W + w + 10}" y="${y + 26}" font-family="ui-monospace, SFMono-Regular, monospace" font-size="13" fill="#1d1d1f">${fmtInt(a.total_tokens)} tok · ${esc(savings)}</text>`,
    ].join('\n');
  })
  .join('\n');

const caption = `Benchmark Lab · ${run.battery.fixture_count} fixtures · battery ${run.battery.fixtures_sha} · build ${run.measured_build.version}@${run.measured_build.commit} · exact tokens (o200k_base)`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
${rows}
  <text x="0" y="${H - 12}" font-family="system-ui, -apple-system, sans-serif" font-size="11" fill="#6e6e73">${esc(caption)}</text>
</svg>
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, svg);
process.stdout.write(`benchmark-lab chart: ${arms.length} arms → ${outPath}\n`);
