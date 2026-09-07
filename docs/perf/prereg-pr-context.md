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

## Verdict — MISSED: primary bar met at 70.5%, quality floor failed at 67%

A run that misses any registered bar publishes as MISSED, so that is the verdict
even though the headline saving cleared its bar comfortably. Which bar failed,
and why it failed only now, is below.

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
published. The primary bar was ≥50% and is still met; the previous figure is
struck, not defended.

**The quality floor is a different story, and it now fails.** It reads
`trace_changed_symbol_readable` ≥ `baseline_changed_symbol_readable`. That
metric counted whether the bundle *listed* a symbol, never whether it carried
the body, so it read 100% in both arms — including through the period when the
trace arm had no source code in it at all. TRA-1100 rewrote it to score
`detail === 'full'`, and this is the first run measured under the corrected
definition:

| | naive | trace-mcp |
|---|---:|---:|
| changed symbols readable (median per PR) | {{ site.data.pr_context_bench.baseline_changed_symbol_readable }} | **{{ site.data.pr_context_bench.trace_changed_symbol_readable }}** |
| affected call sites readable | {{ site.data.pr_context_bench.baseline_dependent_readable }} | {{ site.data.pr_context_bench.trace_dependent_readable }} |
| affected call sites at least located | {{ site.data.pr_context_bench.baseline_dependent_pointed }} | {{ site.data.pr_context_bench.trace_dependent_pointed }} |

A third of the changed symbols arrive without their bodies (113 of 338 across
the corpus), and the previously-published 58% call-site readability was the same
pointer count — it is 28% when bodies are required. **The bar was registered as
unadjustable and it is not being adjusted: this publishes as MISSED.** The
token saving is unaffected — 70.5% is the same number under either definition,
because tokens were always counted on the assembled text.

What it does *not* say is that the review suffers: the
[quality arm]({{ '/perf/prereg-pr-quality/' | relative_url }}), which asks a
model rather than a metric, came back at parity on the same corpus. Both are
true, and the gap between them — a third of changed symbols missing without a
measurable comprehension cost — is the open question, not a resolved one. The
decomposition (module-level pseudo-symbols, whose "body" is a whole file, versus
symbols the 8,000-token budget drops) is not yet measured.

Pull requests where the index did not pay off went from 5 to 56 under the
corrected metric — 43 of them classified `truncated`, which is that same
finding counted per PR rather than per symbol, and 12 costing more than reading
the files outright; they are published in
[`docs/_data/pr_context_bench.json`](../_data/pr_context_bench.json) and on the
[benchmark page]({{ '/pr-context-benchmark.html' | relative_url }}).

Measured at trace-mcp **{{ site.data.pr_context_bench.measured_build.version }}
(`{{ site.data.pr_context_bench.measured_build.commit }}`)** on
{{ site.data.pr_context_bench.generated_at | date: "%-d %B %Y" }}. That build was
reconstructed from the run's timestamp — the run did not record it, which is the
second thing TRA-920 fixed. Every run from now on stamps its own build.
