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
verdict: MET
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

## Verdict — MET (retrospective)

Median 90.6% (13,595 → 1,326 input tokens), changed symbols readable 100% in
both arms, affected call sites readable 60% against 20%. Five of the 60 pull
requests are published as near-ties or losses in
[`docs/_data/pr_context_bench.json`](../_data/pr_context_bench.json) and on the
[benchmark page]({{ '/pr-context-benchmark.html' | relative_url }}).

Measured at trace-mcp **{{ site.data.pr_context_bench.measured_build.version }}
(`{{ site.data.pr_context_bench.measured_build.commit }}`)** on
{{ site.data.pr_context_bench.generated_at | date: "%-d %B %Y" }}. That build was
reconstructed from the run's timestamp — the run did not record it, which is the
second thing TRA-920 fixed. Every run from now on stamps its own build.
