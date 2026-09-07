---
layout: default
title: Preregistration — PR review context benchmark
permalink: /perf/prereg-pr-context/
description: What the PR review context benchmark set out to measure, the bar it had to clear, and the verdict against that bar.
noindex: true
measurement: pr_context
data_file: docs/_data/pr_context_bench.json
preregistration: retrospective
written_on: 2026-09-05
verdict: MISSED
---

# Preregistration — PR review context benchmark

**This file is retrospective.** The run it describes happened on 2026-08-30; this
was written on 2026-09-05, after the numbers were known. Nothing below was
declared in advance, and a bar written after the result is not evidence about
that result — it binds the *next* run of this benchmark, not the one already
published. Saying so is the point: the alternative is a backdated file that
claims a discipline we did not have.

## Question

Does assembling pull-request review context out of the trace-mcp index cost
fewer input tokens than loading the diff plus every file it touches, on code we
do not own — and without hiding more of what the change can break?

## Metric

`savings_pct = (baseline_tokens − trace_tokens) / baseline_tokens`, per pull
request, reported as the **median across pull requests** (not the ratio of
sums — one enormous PR must not carry the figure). Both arms are counted with
`gpt-tokenizer` over the assembled prompt text, never estimated from character
counts.

Emitted by `scripts/bench-pr-context.ts` into `benchmarks/pr-context/results.json`
(`aggregates.median_savings_pct`) and, preformatted for the site, into
`docs/_data/pr_context_bench.json`.

The secondary metrics are quality, and they exist so a token win bought by
dropping information is visible: `changed_symbol_readable`,
`dependent_readable`, `dependent_pointed` — the share of changed symbols and of
affected call sites a reviewer can read or at least locate in the assembled
context.

## Corpus

60 merged pull requests across six open-source repositories we do not own
(`hono`, `axios`, `express`, `requests`, `flask`, `got`), frozen with base and
head SHAs in `benchmarks/pr-context/dataset.json`. Frozen means the run is
reproducible: the dataset file is committed, and re-running against a moved
branch is a different measurement.

## Pass bar

- **Primary:** median `savings_pct` ≥ **50%**.
- **Quality floor:** `trace_changed_symbol_readable` ≥ `baseline_changed_symbol_readable`.
  A token win that makes the changed code less readable is a failure, not a win.

Unadjustable after seeing data. If a future run lands at 48%, it publishes as
MISSED at 48% — the bar does not move to 45%.

## Prediction

Large savings on PRs that touch a handful of files inside a big repository,
shrinking towards zero on small self-contained PRs where the diff *is* the
context. We expected a minority of pull requests where trace-mcp barely pays off
and some where it loses outright; the run publishes those cases rather than
trimming them.

## Control

The baseline arm is a real control, not an estimate: the same 60 pull requests,
the same tokenizer, context assembled by loading the diff plus every file it
touches. That is what makes a miss on this benchmark interpretable — a bad
result would be a result about trace-mcp, not about a guessed baseline. It is
also the reason this figure, and not the aggregate in
[prereg-response-tokens](./prereg-response-tokens.md), leads the storefront.

## Verdict — primary bar MET at 72.8%, quality floor MISSED at 71%

**Corrected 2026-09-07 (TRA-1090).** The 2026-08-30 run measured a trace-mcp arm
that contained no source code: `get_context_bundle` read symbol bodies through a
bare `require('node:fs')`, which throws under ESM and was swallowed by a catch,
so the benchmark — which imports `src/` as real ESM under `tsx` — assembled
signatures only. The shipped build was never affected (its `createRequire`
banner defines `require`), but the published number was measured on a context
the product does not serve. The [diagnosis]({{ '/perf/pr-context-loss-classes/'
| relative_url }}) has the full account.

The same 60 pull requests, same pinned SHAs, re-run with bodies restored:
**median 70.5%** (13,595 → 3,951 input tokens), against the 90.6% first
published. The bar was ≥50% and is still met; the previous figure is struck, not
defended. Changed symbols read 100% readable in both arms then and now — a
metric [since shown to count pointers, not
bodies]({{ '/perf/pr-context-loss-classes/' | relative_url }}), which is why it
did not fire. Pull requests where the index did not pay off went from 5 to 23,
13 of which now cost more than reading the files outright; they are published in
[`docs/_data/pr_context_bench.json`](../_data/pr_context_bench.json) and on the
[benchmark page]({{ '/pr-context-benchmark.html' | relative_url }}).

**Re-measured 2026-09-07 (TRA-1141), at 72.8%.** The 70.5% run was correct
about what the bundle contained; it was also paying for the same bytes twice,
because a symbol and the container it lives inside were both emitted in full.
With that duplication removed the same 60 pull requests, same pinned SHAs,
measure **median 72.8%** (13,595 → 3,286 input tokens) and 21 non-paying PRs,
still 13 of them costlier than reading the files. The bar was ≥50% and is met by
a wider margin; the 70.5% figure is superseded by a re-measurement, not struck
as wrong. The [loss-class page]({{ '/perf/pr-context-loss-classes/' |
relative_url }}) carries the per-section diagnosis, the head-to-head quality
check on the 13 PRs the change touched most (comprehension identical), and the
cost: two coverage columns that were self-reported now measure delivery, and
both fall — `dependent_readable` 58% → 22%, and `changed_symbol_readable`,
which had read 100% since this benchmark was written, → 71%. Most of both drops
is the metric, not the product: measured on the *previous* bundle those columns
read 28% and 67%. The saving itself counts what the two arms actually sent and
is unaffected by the metric. The shortfall the metric exposes — the bundle's
budget falling back to a signature when the changed symbol is larger than its
share, on a third of the corpus — is TRA-1144.

**That makes this preregistration's quality floor MISSED, and the frontmatter
now says so.** The floor reads `trace_changed_symbol_readable` ≥
`baseline_changed_symbol_readable`; the run measures 71% against the baseline's
100%. It was written when that column could not fail — it scored a symbol as
readable whenever the bundle listed it, so both arms read 100% by construction
— and the first run able to fail it does. The bar is not moved to fit: a
preregistration that passes on one axis and fails on another is a normal
outcome, and the primary bar (≥50%, measured 72.8%) is unaffected by the miss.
Raising the floor is TRA-1144's job, and until it lands this page reads MISSED.
Caught in review of TRA-1141, which computed the number and left the verdict
untouched.

Measured at trace-mcp **{{ site.data.pr_context_bench.measured_build.version }}
(`{{ site.data.pr_context_bench.measured_build.commit }}`)** on
{{ site.data.pr_context_bench.generated_at | date: "%-d %B %Y" }}. The 2026-08-30
build was reconstructed from the run's timestamp — the run did not record it, which is the
second thing TRA-920 fixed. Every run from now on stamps its own build.
