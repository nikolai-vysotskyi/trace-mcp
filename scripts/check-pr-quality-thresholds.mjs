#!/usr/bin/env node
// TRA-1100 — the release-time half of the context-quality gate. The PR-review
// quality benchmark (scripts/bench-pr-quality.ts) needs ~180 headless model
// calls through a subscription, not an API key, and takes over an hour — it
// cannot run on every PR in CI. What CAN run on every release is checking the
// numbers it already wrote down against the bar preregistered in
// docs/perf/prereg-pr-quality.md, so a quality regression the full harness
// caught can't ship silently just because nobody re-read the JSON by eye.
//
// Reads benchmarks/pr-context/quality.json (bench-pr-quality.ts's raw output),
// not docs/_data/pr_context_quality.json — that second file exists only to
// feed the docs site and stores pre-rounded percentage strings, which can hide
// a true miss near the boundary. Also validates the run is the one registered
// bar was set against: the full 60-PR corpus, zero failed model calls, the
// registered reviewer and judge models — a 1-row smoke run or a mostly-failed
// attempt must not report MET just because the rows it did get looked fine.
//
// Usage (after running bench-pr-context.ts --dump-prompts && bench-pr-quality.ts):
//   node scripts/check-pr-quality-thresholds.mjs [--json]
//
// Exit 0 = MET, exit 1 = MISSED or the data file is missing/malformed/incomplete.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DATA_PATH = path.join(process.cwd(), 'benchmarks/pr-context/quality.json');

/** Registered in docs/perf/prereg-pr-quality.md — do not move these after seeing data. */
export const MAX_UNDERSTOOD_DROP_PP = 10;
export const MAX_FALSE_POSITIVE_INCREASE = 0.5;
/** The registered corpus (docs/perf/prereg-pr-quality.md, "Corpus"): 60 PRs. */
export const MIN_PR_COUNT = 60;
/** Must match MODEL / JUDGE_MODEL in scripts/bench-pr-quality.ts. */
export const EXPECTED_MODEL = 'claude-sonnet-4-5';
export const EXPECTED_JUDGE_MODEL = 'claude-sonnet-4-5';

/**
 * Pure so the bar is testable without touching the filesystem. Takes
 * bench-pr-quality.ts's raw `quality.json` shape, not the rounded docs one.
 * @param {{
 *   pr_count: number,
 *   failed?: Array<unknown>,
 *   model: string,
 *   judge_model: string,
 *   aggregates: {
 *     baseline: { understood_rate: number, false_positives_per_pr: number },
 *     trace: { understood_rate: number, false_positives_per_pr: number },
 *   },
 * }} data
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function evaluatePrQualityThresholds(data) {
  const reasons = [];

  const failedCount = Array.isArray(data.failed) ? data.failed.length : 0;
  if (!(Number(data.pr_count) >= MIN_PR_COUNT)) {
    reasons.push(`ran on ${data.pr_count} PR(s), the registered corpus is ${MIN_PR_COUNT}`);
  }
  if (failedCount > 0) {
    reasons.push(
      `${failedCount} PR(s) failed a model call and were excluded from this run — a partial ` +
        `run cannot be judged against a full-corpus bar`,
    );
  }
  if (data.model !== EXPECTED_MODEL) {
    reasons.push(`reviewer model was "${data.model}", registered model is "${EXPECTED_MODEL}"`);
  }
  if (data.judge_model !== EXPECTED_JUDGE_MODEL) {
    reasons.push(
      `judge model was "${data.judge_model}", registered judge is "${EXPECTED_JUDGE_MODEL}"`,
    );
  }

  const baselineUnderstood = data.aggregates?.baseline?.understood_rate;
  const traceUnderstood = data.aggregates?.trace?.understood_rate;
  const baselineFp = data.aggregates?.baseline?.false_positives_per_pr;
  const traceFp = data.aggregates?.trace?.false_positives_per_pr;
  if (
    typeof baselineUnderstood !== 'number' ||
    typeof traceUnderstood !== 'number' ||
    typeof baselineFp !== 'number' ||
    typeof traceFp !== 'number'
  ) {
    reasons.push(
      'aggregates.{baseline,trace}.{understood_rate,false_positives_per_pr} missing or not numeric',
    );
    return { ok: false, reasons };
  }

  const understoodDropPp = (baselineUnderstood - traceUnderstood) * 100;
  const fpIncrease = traceFp - baselineFp;

  if (understoodDropPp > MAX_UNDERSTOOD_DROP_PP) {
    reasons.push(
      `comprehension dropped ${understoodDropPp.toFixed(1)}pp (${(baselineUnderstood * 100).toFixed(1)}% → ` +
        `${(traceUnderstood * 100).toFixed(1)}%), bar allows ${MAX_UNDERSTOOD_DROP_PP}pp`,
    );
  }
  if (fpIncrease > MAX_FALSE_POSITIVE_INCREASE) {
    reasons.push(
      `false positives per PR rose by ${fpIncrease.toFixed(2)} (${baselineFp.toFixed(2)} → ` +
        `${traceFp.toFixed(2)}), bar allows ${MAX_FALSE_POSITIVE_INCREASE}`,
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
    const t = data.aggregates.trace;
    const b = data.aggregates.baseline;
    console.log(
      `MET — ${data.pr_count} PRs, 0 failed — ${(t.understood_rate * 100).toFixed(1)}% understood ` +
        `(baseline ${(b.understood_rate * 100).toFixed(1)}%), ${t.false_positives_per_pr.toFixed(2)} ` +
        `false positives/PR (baseline ${b.false_positives_per_pr.toFixed(2)})`,
    );
  } else {
    console.error(`MISSED:\n${result.reasons.map((r) => `- ${r}`).join('\n')}`);
  }

  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
