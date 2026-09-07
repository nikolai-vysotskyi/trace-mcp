#!/usr/bin/env node
// TRA-1100 — the release-time half of the context-quality gate. The PR-review
// quality benchmark (scripts/bench-pr-quality.ts) needs ~180 headless model
// calls through a subscription, not an API key, and takes over an hour — it
// cannot run on every PR in CI. What CAN run on every release is checking the
// numbers it already wrote down against the bar preregistered in
// docs/perf/prereg-pr-quality.md, so a quality regression the full harness
// caught can't ship silently just because nobody re-read the JSON by eye.
//
// Usage (after running bench-pr-context.ts --dump-prompts && bench-pr-quality.ts):
//   node scripts/check-pr-quality-thresholds.mjs [--json]
//
// Exit 0 = MET, exit 1 = MISSED or the data file is missing/malformed.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DATA_PATH = path.join(process.cwd(), 'docs/_data/pr_context_quality.json');

/** Registered in docs/perf/prereg-pr-quality.md — do not move these after seeing data. */
export const MAX_UNDERSTOOD_DROP_PP = 10;
export const MAX_FALSE_POSITIVE_INCREASE = 0.5;

function parsePct(s) {
  const n = Number.parseFloat(String(s).replace('%', ''));
  if (Number.isNaN(n)) throw new Error(`not a percentage: ${s}`);
  return n;
}

function parseNum(s) {
  const n = Number.parseFloat(String(s));
  if (Number.isNaN(n)) throw new Error(`not a number: ${s}`);
  return n;
}

/**
 * Pure so the bar is testable without touching the filesystem.
 * @param {{ baseline_understood: string, trace_understood: string, baseline_false_positives: string, trace_false_positives: string }} data
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function evaluatePrQualityThresholds(data) {
  const baselineUnderstood = parsePct(data.baseline_understood);
  const traceUnderstood = parsePct(data.trace_understood);
  const baselineFp = parseNum(data.baseline_false_positives);
  const traceFp = parseNum(data.trace_false_positives);

  const understoodDropPp = baselineUnderstood - traceUnderstood;
  const fpIncrease = traceFp - baselineFp;

  const reasons = [];
  if (understoodDropPp > MAX_UNDERSTOOD_DROP_PP) {
    reasons.push(
      `comprehension dropped ${understoodDropPp.toFixed(1)}pp (${data.baseline_understood} → ` +
        `${data.trace_understood}), bar allows ${MAX_UNDERSTOOD_DROP_PP}pp`,
    );
  }
  if (fpIncrease > MAX_FALSE_POSITIVE_INCREASE) {
    reasons.push(
      `false positives per PR rose by ${fpIncrease.toFixed(2)} (${data.baseline_false_positives} → ` +
        `${data.trace_false_positives}), bar allows ${MAX_FALSE_POSITIVE_INCREASE}`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

function main() {
  const asJson = process.argv.includes('--json');

  if (!fs.existsSync(DATA_PATH)) {
    const msg = `${DATA_PATH} does not exist — run scripts/bench-pr-context.ts --dump-prompts and scripts/bench-pr-quality.ts first`;
    if (asJson) console.log(JSON.stringify({ ok: false, reasons: [msg] }));
    else console.error(msg);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const result = evaluatePrQualityThresholds(data);

  if (asJson) {
    console.log(JSON.stringify(result));
  } else if (result.ok) {
    console.log(
      `MET — ${data.trace_understood} understood (baseline ${data.baseline_understood}), ` +
        `${data.trace_false_positives} false positives/PR (baseline ${data.baseline_false_positives})`,
    );
  } else {
    console.error(`MISSED:\n${result.reasons.map((r) => `- ${r}`).join('\n')}`);
  }

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
