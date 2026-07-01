#!/usr/bin/env node
/**
 * Health-metric calibration harness.
 *
 * Question: do the git-derived signals that feed `get_risk_hotspots` and
 * `predict_bugs` actually correlate with where bugs get fixed later?
 *
 * Method (temporal holdout — avoids the circularity of using fixes as both a
 * signal AND a label):
 *   1. Split the commit history at the midpoint date.
 *   2. EARLY window  → compute per-file signals: churn (commits) and
 *      recent-fix count. These are the inputs both tools rely on.
 *   3. LATE window   → label set: number of FIX commits touching each file.
 *   4. Score each file by each signal, then measure:
 *        - Spearman rank correlation (signal vs. future fix count)
 *        - precision@K (of the top-K files by signal, how many are in the
 *          top-K files by future fixes)
 *   5. Compare against a random/uniform baseline.
 *
 * This calibrates the SHARED git signals, not the full weighted blend (which
 * also folds in complexity/coupling/pagerank from the trace index). It is a
 * triage-quality check, NOT a validated bug-prediction benchmark — treat the
 * numbers as directional evidence about signal usefulness.
 *
 * Usage:  node scripts/calibrate-health-metrics.mjs [--since-days N] [--k K]
 *
 * Exits 0 always (reporting tool). Prints a JSON + human summary to stdout.
 */

import { execFileSync } from 'node:child_process';

const FIX_PATTERN = /\b(fix|bug|patch|hotfix|repair|resolve|correct)\b/i;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|java|rs|c|cpp|cs|kt|swift)$/;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const SINCE_DAYS = Number(arg('--since-days', '365'));
const K = Number(arg('--k', '20'));

/** Pull commits with author date + subject + touched files. */
function gitLog(sinceDays) {
  const out = execFileSync(
    'git',
    [
      'log',
      '--pretty=format:__C__%H|%aI|%s',
      '--name-only',
      '--no-merges',
      '--diff-filter=ACDMR',
      `--since=${sinceDays} days ago`,
    ],
    { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  ).toString('utf-8');

  const commits = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('__C__')) {
      if (cur) commits.push(cur);
      // Format: __C__<hash>|<authorISODate>|<subject possibly containing |>
      const meta = line.slice('__C__'.length);
      const i1 = meta.indexOf('|');
      const i2 = meta.indexOf('|', i1 + 1);
      const date = i1 >= 0 && i2 >= 0 ? meta.slice(i1 + 1, i2) : '';
      const subject = i2 >= 0 ? meta.slice(i2 + 1) : '';
      cur = { date: new Date(date), isFix: FIX_PATTERN.test(subject), files: [] };
    } else {
      const f = line.trim();
      if (f && CODE_EXT.test(f) && cur) cur.files.push(f);
    }
  }
  if (cur) commits.push(cur);
  return commits.filter((c) => c.files.length > 0 && !Number.isNaN(c.date.getTime()));
}

/** Spearman rank correlation between two aligned numeric arrays. */
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1; // average rank for ties, 1-indexed
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

/** precision@K: fraction of top-K by `signal` that are in the top-K by `label`. */
export function precisionAtK(files, signal, label, k) {
  const topSig = [...files].sort((a, b) => (signal.get(b) ?? 0) - (signal.get(a) ?? 0)).slice(0, k);
  const topLabSet = new Set(
    [...files]
      .filter((f) => (label.get(f) ?? 0) > 0)
      .sort((a, b) => (label.get(b) ?? 0) - (label.get(a) ?? 0))
      .slice(0, k),
  );
  if (topSig.length === 0 || topLabSet.size === 0) return 0;
  const hits = topSig.filter((f) => topLabSet.has(f)).length;
  return hits / Math.min(k, topSig.length);
}

/**
 * Split commits chronologically at the midpoint into an EARLY (signal) window
 * and a LATE (label) window.
 */
export function splitCommits(commits) {
  const sorted = [...commits].sort((a, b) => a.date - b.date);
  const mid = Math.floor(sorted.length / 2);
  return { early: sorted.slice(0, mid), late: sorted.slice(mid) };
}

/**
 * EARLY-window signals: per-file churn (commit count) and recent-fix count.
 * Returns two Maps keyed by file path.
 */
export function buildEarlySignals(early) {
  const churn = new Map();
  const earlyFix = new Map();
  for (const c of early) {
    for (const f of c.files) {
      churn.set(f, (churn.get(f) ?? 0) + 1);
      if (c.isFix) earlyFix.set(f, (earlyFix.get(f) ?? 0) + 1);
    }
  }
  return { churn, earlyFix };
}

/** LATE-window label: future fix-commit count per file. */
export function buildFutureFixLabels(late) {
  const futureFix = new Map();
  for (const c of late) {
    if (!c.isFix) continue;
    for (const f of c.files) futureFix.set(f, (futureFix.get(f) ?? 0) + 1);
  }
  return futureFix;
}

/**
 * Score the EARLY signals against the LATE labels (Spearman + precision@K +
 * random baseline) and assemble the JSON report object.
 */
export function buildReport(commits, early, late, churn, earlyFix, futureFix) {
  // Universe: files seen in the EARLY window (so we can only "predict" files
  // that existed). This is the realistic deployment setting.
  const files = [...churn.keys()];
  const labelArr = files.map((f) => futureFix.get(f) ?? 0);
  const churnArr = files.map((f) => churn.get(f) ?? 0);
  const earlyFixArr = files.map((f) => earlyFix.get(f) ?? 0);

  const rChurn = spearman(churnArr, labelArr);
  const rEarlyFix = spearman(earlyFixArr, labelArr);

  const pChurn = precisionAtK(files, churn, futureFix, K);
  const pEarlyFix = precisionAtK(files, earlyFix, futureFix, K);

  // Random baseline precision@K = (files with future fixes) / (total files).
  const labeled = files.filter((f) => (futureFix.get(f) ?? 0) > 0).length;
  const randomP = files.length ? labeled / files.length : 0;

  return {
    status: 'ok',
    window_days: SINCE_DAYS,
    commits_total: commits.length,
    commits_early: early.length,
    commits_late: late.length,
    files_in_early_window: files.length,
    files_with_future_fixes: labeled,
    k: K,
    spearman: {
      churn_vs_future_fixes: Number(rChurn.toFixed(3)),
      recent_fixes_vs_future_fixes: Number(rEarlyFix.toFixed(3)),
    },
    [`precision_at_${K}`]: {
      churn: Number(pChurn.toFixed(3)),
      recent_fixes: Number(pEarlyFix.toFixed(3)),
      random_baseline: Number(randomP.toFixed(3)),
    },
    interpretation:
      'Spearman > 0 means the signal ranks future-buggy files higher than chance. ' +
      'precision@K above the random baseline means the top-K hotspots are enriched for ' +
      'files that actually got fixed later. These calibrate the shared git signals only; ' +
      'they are heuristic triage evidence, not a validated bug-prediction benchmark.',
  };
}

function main() {
  const commits = gitLog(SINCE_DAYS);
  if (commits.length < 10) {
    console.log(
      JSON.stringify(
        { status: 'insufficient_history', commits: commits.length, note: 'Need >=10 commits.' },
        null,
        2,
      ),
    );
    return;
  }

  const { early, late } = splitCommits(commits);
  const { churn, earlyFix } = buildEarlySignals(early);
  const futureFix = buildFutureFixLabels(late);
  const report = buildReport(commits, early, late, churn, earlyFix, futureFix);

  console.log(JSON.stringify(report, null, 2));

  // Human one-liner.
  const pEarlyFix = report[`precision_at_${K}`].recent_fixes;
  const randomP = report[`precision_at_${K}`].random_baseline;
  const lift = randomP > 0 ? (pEarlyFix / randomP).toFixed(1) : 'n/a';
  console.error(
    `\nSummary: churn ρ=${report.spearman.churn_vs_future_fixes}, ` +
      `recent-fix ρ=${report.spearman.recent_fixes_vs_future_fixes}; ` +
      `precision@${K}: recent-fix=${report[`precision_at_${K}`].recent_fixes} ` +
      `vs random=${report[`precision_at_${K}`].random_baseline} (${lift}x lift).`,
  );
}

// Only run the git-dependent analysis when invoked directly (node scripts/...),
// not when imported by a test that exercises the pure helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
